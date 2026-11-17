import { describe, expect, it } from 'vitest'
import { boundsOf, fitZoom, focusBox } from '../../src/shared/focus'
import type { MarginNote, Rect, Target } from '../../src/shared/types'

const note = (box: Rect, targetIds: string[], page = 2): MarginNote => ({
  id: 'm', page, box, strokeIds: [], text: 'Why?', candidates: [], corrected: false, kind: 'note',
  targetIds, createdAt: '', updatedAt: ''
})
const mark = (id: string, rects: Rect[], page = 2): Target => ({ id, kind: 'text', page, rects, style: 'circle', createdAt: '' })

describe('going to a note from a link', () => {
  it('shows the note with the nearest mark it links to', () => {
    const near = mark('near', [[100, 100, 200, 10], [100, 112, 150, 10]])
    const far = mark('far', [[100, 600, 200, 10]])
    const box = focusBox(note([-80, 105, 40, 20], ['far', 'near']), [far, near])
    expect(box).toEqual([-80, 100, 380, 25])
  })

  it('leaves out marks on other pages, whole-page links and marks it does not link to', () => {
    const n = note([-80, 105, 40, 20], ['other-page', 'page'])
    const targets: Target[] = [
      mark('other-page', [[100, 100, 50, 10]], 3),
      { id: 'page', kind: 'page', page: 2, createdAt: '' },
      mark('unlinked', [[100, 100, 50, 10]])
    ]
    expect(focusBox(n, targets)).toEqual(n.box)
  })

  it('zooms so the box and its room fill the view, within limits', () => {
    // 400 wide in an 1000-wide view with 50 px each side: 900 / 400.
    expect(fitZoom([0, 0, 400, 100], 1000, 800, 50, 0.3, 4)).toBeCloseTo(2.25)
    // Height decides when the box is tall.
    expect(fitZoom([0, 0, 100, 700], 1000, 800, 50, 0.3, 4)).toBeCloseTo(1)
    expect(fitZoom([0, 0, 20, 10], 1000, 800, 50, 0.3, 3)).toBe(3)
    expect(fitZoom([0, 0, 5000, 5000], 1000, 800, 50, 0.3, 3)).toBe(0.3)
  })

  it('bounds several boxes', () => {
    expect(boundsOf([[0, 0, 10, 10], [20, -5, 5, 5]])).toEqual([0, -5, 25, 15])
  })
})
