# Third-party notices

Obelus itself is MIT-licensed (see `LICENSE`). The reading models below are **not part of the
installer**: the app downloads them, from their original places, only when you choose to (Settings →
Reading on this computer). Each file is pinned to one version and checked against a SHA-256 checksum
(`src/main/models/catalog.ts`).

## llama.cpp

Runs the models on your computer. Downloaded from <https://github.com/ggml-org/llama.cpp/releases>
(release `b12633`, the CPU build for Windows x64 or Ubuntu x64).

```
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Maths reader (Windows): Uni-MuMER-Qwen3.5-2B

- Model: [phxember/Uni-MuMER-Qwen3.5-2B](https://huggingface.co/phxember/Uni-MuMER-Qwen3.5-2B),
  Apache License 2.0. From Uni-MuMER (Li et al., *Unified Multi-Task Fine-Tuning of Vision-Language
  Model for Handwritten Mathematical Expression Recognition*, NeurIPS 2025, [arXiv 2505.23566](https://arxiv.org/abs/2505.23566)), <https://github.com/BFlameSwift/Uni-MuMER>,
  Apache License 2.0.
- Based on [Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) by the Qwen team, Alibaba Cloud,
  Apache License 2.0.
- Files downloaded: the GGUF conversion by mradermacher,
  [mradermacher/Uni-MuMER-Qwen3.5-2B-GGUF](https://huggingface.co/mradermacher/Uni-MuMER-Qwen3.5-2B-GGUF)
  (`Uni-MuMER-Qwen3.5-2B.Q8_0.gguf`, `Uni-MuMER-Qwen3.5-2B.mmproj-f16.gguf`), Apache License 2.0.

## Handwriting reader (Linux): Qwen3.5-4B

- Model: [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) by the Qwen team, Alibaba Cloud,
  Apache License 2.0.
- Files downloaded: the GGUF conversion by Unsloth,
  [unsloth/Qwen3.5-4B-GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF)
  (`Qwen3.5-4B-Q4_K_M.gguf`, `mmproj-F16.gguf`), Apache License 2.0.

The Apache License 2.0 is at <https://www.apache.org/licenses/LICENSE-2.0>. The models are used
unchanged; the app only renames the downloaded files.
