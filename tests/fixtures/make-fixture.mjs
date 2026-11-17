// Generates tests/fixtures/sample.pdf: a small paper with known text positions, a figure area,
// and citation links into a bibliography. Run with: node tests/fixtures/make-fixture.mjs
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.TimesRoman)
const bold = await doc.embedFont(StandardFonts.TimesRomanBold)
const W = 612
const H = 792
const page1 = doc.addPage([W, H])
const page2 = doc.addPage([W, H])
const L = 100

doc.setTitle('A Sample Paper About Handwriting Margins')

page1.drawText('A Sample Paper About Handwriting Margins', { x: L, y: 720, size: 16, font: bold })
const body = [
  'Diffusion models have become a standard tool for motion generation and',
  'they produce convincing results across many difficult benchmark tasks.',
  'Our method builds on earlier work [1] and extends the idea of implicit',
  'curves to long sequences, following the approach of a prior study [2].',
  'The second sentence of this paragraph explains the training procedure',
  'and the third sentence reports the evaluation on held out sequences.'
]
body.forEach((t, i) => page1.drawText(t, { x: L, y: 680 - i * 16, size: 12, font }))
page1.drawRectangle({ x: L, y: 400, width: 300, height: 150, color: rgb(0.85, 0.9, 0.95) })
page1.drawText('Figure 1: A figure area with a caption below it.', { x: L, y: 385, size: 10, font })

page2.drawText('References', { x: L, y: 720, size: 14, font: bold })
const refs = [
  ['[1] A. Author and B. Writer. Implicit Curves for Motion Synthesis. In', 'Proceedings of the Test Conference, 2023.'],
  ['[2] C. Researcher. Long Sequence Generation with Latent Models. arXiv', 'preprint arXiv:2301.12345, 2023.'],
  ['[3] D. Nobody. Nothing Here Can Be Found Anywhere At All. Journal of', 'Missing Results, 1999.']
]
let y = 690
const destTops = []
for (const lines of refs) {
  destTops.push(y + 12)
  lines.forEach((t, i) => page2.drawText(t, { x: L, y: y - i * 14, size: 11, font }))
  y -= 44
}

function linkTo(page, rect, destIndex) {
  const ctx = doc.context
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    Dest: [page2.ref, PDFName.of('XYZ'), L, destTops[destIndex], null]
  })
  const ref = ctx.register(annot)
  const annots = page.node.lookup(PDFName.of('Annots'))
  if (annots) annots.push(ref)
  else page.node.set(PDFName.of('Annots'), ctx.obj([ref]))
}

function linkAtPhrase(lineIndex, before, label, destIndex) {
  const yBase = 680 - lineIndex * 16
  const x0 = L + font.widthOfTextAtSize(before, 12)
  const x1 = x0 + font.widthOfTextAtSize(label, 12)
  linkTo(page1, [x0, yBase - 2, x1, yBase + 10], destIndex)
}

linkAtPhrase(2, 'Our method builds on earlier work ', '[1]', 0)
linkAtPhrase(3, 'curves to long sequences, following the approach of a prior study ', '[2]', 1)

// A third citation for the "nothing found" path.
const yExtra = 340
page1.drawText('See also an obscure reference [3] here.', { x: L, y: yExtra, size: 12, font })
const x0 = L + font.widthOfTextAtSize('See also an obscure reference ', 12)
linkTo(page1, [x0, yExtra - 2, x0 + font.widthOfTextAtSize('[3]', 12), yExtra + 10], 2)

// A web link.
const url = doc.context.obj({
  Type: 'Annot',
  Subtype: 'Link',
  Rect: [L, 300, L + 200, 314],
  Border: [0, 0, 0],
  A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.test/') }
})
page1.drawText('A web link at example.test', { x: L, y: 302, size: 12, font })
page1.node.lookup(PDFName.of('Annots')).push(doc.context.register(url))

// A displayed equation drawn glyph by glyph, as PDFs store maths, with its number on the right.
const eqY = 250
const glyphs = [
  ['L', 0, 0, 12], ['=', 12, 0, 12], ['x', 26, 0, 12], ['2', 33, 5, 8], ['+', 42, 0, 12], ['y', 54, 0, 12], ['i', 60, -3, 8]
]
for (const [t, dx, dy, size] of glyphs) page1.drawText(t, { x: L + 100 + dx, y: eqY + dy, size, font })
page1.drawText('(1)', { x: L + 300, y: eqY, size: 12, font })

const center = (line, before, label) => [
  L + font.widthOfTextAtSize(before, 12) + font.widthOfTextAtSize(label, 12) / 2,
  H - (680 - line * 16) - 4
]
writeFileSync(
  join(here, 'sample-links.json'),
  JSON.stringify({
    ref1: center(2, 'Our method builds on earlier work ', '[1]'),
    ref2: center(3, 'curves to long sequences, following the approach of a prior study ', '[2]'),
    ref3: [x0 + font.widthOfTextAtSize('[3]', 12) / 2, H - yExtra - 4]
  })
)
writeFileSync(join(here, 'sample.pdf'), await doc.save())
console.log('wrote sample.pdf')
