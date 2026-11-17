import { useMemo, useRef, useState } from 'react'
import { suggestTags } from '../../shared/tags'

/**
 * The "+ tag" box. While typing it lists existing tags that start with or contain the text (Enter
 * takes the first) and, separately, tags it might be a typo of, which are only offered: Enter
 * never swaps typed text for one of those. Arrow keys move through the list; Tab or a tap picks.
 */
export function TagInput({ have, all, onAdd }: { have: string[]; all: string[]; onAdd: (tag: string) => void }) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [pick, setPick] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const s = useMemo(() => suggestTags(text, all, have), [text, all, have])
  const items = [...s.complete, ...s.didYouMean]
  // The first completion is picked unless the arrows chose something else; a near miss never is.
  const chosen = pick ?? (s.complete.length ? 0 : -1)
  const open = focused && text.trim() !== '' && items.length > 0
  const rect = open ? input.current?.getBoundingClientRect() : undefined

  const add = (tag: string) => {
    const t = tag.trim()
    if (!t) return
    onAdd(t)
    setText('')
    setPick(null)
  }

  return (
    <>
      <input ref={input} className="tag-input" placeholder="+ tag" data-testid="tag-input" value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => { setText(e.target.value); setPick(null) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setPick(Math.min(items.length - 1, chosen + 1)) }
          else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setPick(Math.max(-1, chosen - 1)) }
          else if (e.key === 'Tab' && open && chosen >= 0) { e.preventDefault(); add(items[chosen]) }
          else if (e.key === 'Enter') { e.preventDefault(); add(open && chosen >= 0 ? items[chosen] : text) }
          else if (e.key === 'Escape') { if (open) { e.preventDefault(); setText(''); setPick(null) } }
        }} />
      {open && rect && (
        <div className="tag-suggest" data-testid="tag-suggest" style={{ left: rect.left, top: rect.bottom + 2, minWidth: Math.max(rect.width, 160) }}>
          {s.complete.map((t, i) => (
            <button key={t} className={i === chosen ? 'on' : ''} data-testid="tag-complete"
              onPointerDown={(e) => e.preventDefault()} onClick={() => add(t)}>{t}</button>
          ))}
          {s.didYouMean.length > 0 && <div className="tag-suggest-label">Did you mean</div>}
          {s.didYouMean.map((t, j) => (
            <button key={t} className={s.complete.length + j === chosen ? 'on' : ''} data-testid="tag-did-you-mean"
              onPointerDown={(e) => e.preventDefault()} onClick={() => add(t)}>{t}?</button>
          ))}
          {chosen < 0 && <div className="tag-suggest-label">Enter adds “{text.trim()}” as a new tag</div>}
        </div>
      )}
    </>
  )
}
