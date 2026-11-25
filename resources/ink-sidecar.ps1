# Handwriting recognition helper. Started by the app and kept running.
# Protocol: one JSON request per line on stdin, one JSON response per line on stdout.
#   {"id":1,"method":"list"}
#   {"id":2,"method":"recognize","recognizer":"name","scale":2.0,"lines":[[[x,y,x,y,...],...],...]}
# A "line" is a list of strokes, and each stroke is a flat list of coordinates.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.UI.Input.Inking.InkStrokeBuilder, Windows.UI.Input.Inking, ContentType = WindowsRuntime]
$null = [Windows.UI.Input.Inking.InkStrokeContainer, Windows.UI.Input.Inking, ContentType = WindowsRuntime]
$null = [Windows.UI.Input.Inking.InkRecognizerContainer, Windows.UI.Input.Inking, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
$resultListType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Input.Inking.InkRecognitionResult]]
$awaitResults = $asTask.MakeGenericMethod($resultListType)

$recognizers = New-Object Windows.UI.Input.Inking.InkRecognizerContainer
$builder = New-Object Windows.UI.Input.Inking.InkStrokeBuilder

# The Windows spell checkers, used to tell which recognizer produced real words.
$spellReady = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("B7C82D61-FBE8-4B47-9B27-6C0D2E0DE0A3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPrSpellingError { }
[ComImport, Guid("803E3BD4-2828-4410-8290-418D1D73C762"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPrEnumSpellingError { [PreserveSig] int Next([MarshalAs(UnmanagedType.Interface)] out IPrSpellingError value); }
[ComImport, Guid("B6FD0B71-E2BC-4653-8D05-F197E412770B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPrSpellChecker {
  [PreserveSig] int get_LanguageTag(out IntPtr tag);
  [PreserveSig] int Check([MarshalAs(UnmanagedType.LPWStr)] string text, [MarshalAs(UnmanagedType.Interface)] out IPrEnumSpellingError errors);
}
[ComImport, Guid("8E018A9D-2415-4677-BF08-794EA61F94BB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPrSpellFactory {
  [PreserveSig] int get_SupportedLanguages([MarshalAs(UnmanagedType.Interface)] out IEnumString languages);
  [PreserveSig] int IsSupported([MarshalAs(UnmanagedType.LPWStr)] string tag, out int supported);
  [PreserveSig] int CreateSpellChecker([MarshalAs(UnmanagedType.LPWStr)] string tag, [MarshalAs(UnmanagedType.Interface)] out IPrSpellChecker checker);
}
[ComImport, Guid("7AB36653-1796-484B-BDFA-E74F1DB7C1DC")] public class PrSpellFactory { }
public static class PrSpell {
  private static readonly List<IPrSpellChecker> Checkers = new List<IPrSpellChecker>();
  public static int Count { get { return Checkers.Count; } }
  public static void Load() {
    var factory = (IPrSpellFactory)new PrSpellFactory();
    IEnumString languages;
    if (factory.get_SupportedLanguages(out languages) != 0) return;
    var one = new string[1];
    while (languages.Next(1, one, IntPtr.Zero) == 0) {
      IPrSpellChecker checker;
      if (factory.CreateSpellChecker(one[0], out checker) == 0) Checkers.Add(checker);
    }
  }
  public static bool IsWord(string word) {
    foreach (var checker in Checkers) {
      IPrEnumSpellingError errors;
      if (checker.Check(word, out errors) != 0) continue;
      IPrSpellingError error;
      if (errors.Next(out error) != 0) return true;
    }
    return false;
  }
}
'@
    [PrSpell]::Load()
    $spellReady = $true
}
catch {
    $spellReady = $false
}

function Send($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

function New-Stroke($flat, [double]$scale) {
    $list = New-Object 'System.Collections.Generic.List[Windows.Foundation.Point]'
    for ($i = 0; $i -lt $flat.Count - 1; $i += 2) {
        $list.Add((New-Object Windows.Foundation.Point(([double]$flat[$i] * $scale), ([double]$flat[$i + 1] * $scale))))
    }
    if ($list.Count -eq 1) {
        # A dot, such as the top of an "i", still has to be a stroke of two points.
        $p = $list[0]
        $list.Add((New-Object Windows.Foundation.Point(($p.X + 0.5), ($p.Y + 0.5))))
    }
    return $builder.CreateStroke($list)
}

function Find-Recognizer([string]$name) {
    $all = @($recognizers.GetRecognizers())
    foreach ($r in $all) { if ($r.Name -eq $name) { return $r } }
    if ($all.Count -gt 0) { return $all[0] }
    return $null
}

function Invoke-RecognizeLine($strokes, [double]$scale) {
    $container = New-Object Windows.UI.Input.Inking.InkStrokeContainer
    foreach ($s in $strokes) { $container.AddStroke((New-Stroke $s $scale)) }
    $op = $recognizers.RecognizeAsync($container, [Windows.UI.Input.Inking.InkRecognitionTarget]::All)
    $task = $awaitResults.Invoke($null, @($op))
    if (-not $task.Wait(12000)) { throw 'Recognition timed out' }
    $words = New-Object System.Collections.ArrayList
    $sorted = @($task.Result) | Sort-Object { $_.BoundingRect.X }
    foreach ($result in $sorted) {
        $alts = @($result.GetTextCandidates())
        # Where the word is, in the caller's units, so its strokes can be found (maths inside text).
        $r = $result.BoundingRect
        $box = @(($r.X / $scale), ($r.Y / $scale), ($r.Width / $scale), ($r.Height / $scale))
        [void]$words.Add(@{ alts = $alts; box = $box })
    }
    return , $words
}

Send @{ event = 'ready' }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $id = 0
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        if ($req.method -eq 'list') {
            $names = @(@($recognizers.GetRecognizers()) | ForEach-Object { $_.Name })
            Send @{ id = $id; ok = $true; recognizers = $names }
        }
        elseif ($req.method -eq 'recognize') {
            $recognizer = Find-Recognizer ([string]$req.recognizer)
            if ($null -eq $recognizer) { throw 'No handwriting recognizer is installed' }
            $recognizers.SetDefaultRecognizer($recognizer)
            $out = New-Object System.Collections.ArrayList
            foreach ($strokes in @($req.lines)) {
                $words = Invoke-RecognizeLine @($strokes) ([double]$req.scale)
                [void]$out.Add(@{ words = @($words) })
            }
            Send @{ id = $id; ok = $true; recognizer = $recognizer.Name; lines = @($out) }
        }
        elseif ($req.method -eq 'recognizeAll') {
            $results = New-Object System.Collections.ArrayList
            $only = @($req.only | Where-Object { $_ })
            foreach ($recognizer in @($recognizers.GetRecognizers())) {
                if ($only.Count -gt 0 -and $only -notcontains $recognizer.Name) { continue }
                try {
                    $recognizers.SetDefaultRecognizer($recognizer)
                    $out = New-Object System.Collections.ArrayList
                    foreach ($strokes in @($req.lines)) {
                        $words = Invoke-RecognizeLine @($strokes) ([double]$req.scale)
                        [void]$out.Add(@{ words = @($words) })
                    }
                    [void]$results.Add(@{ recognizer = $recognizer.Name; lines = @($out) })
                }
                catch { }
            }
            Send @{ id = $id; ok = $true; results = @($results) }
        }
        elseif ($req.method -eq 'spell') {
            if (-not $spellReady) { throw 'The spell checkers could not be loaded' }
            $valid = New-Object System.Collections.ArrayList
            foreach ($word in @($req.words)) {
                if ([PrSpell]::IsWord([string]$word)) { [void]$valid.Add([string]$word) }
            }
            Send @{ id = $id; ok = $true; valid = @($valid); languages = [PrSpell]::Count }
        }
        else {
            throw "Unknown method: $($req.method)"
        }
    }
    catch {
        Send @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}
