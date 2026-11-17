import { useCallback, useEffect, useRef, useState } from 'react'
import { Layer } from '../../shared/types'

const SAVE_DELAY_MS = 400
const UNDO_LIMIT = 100

export interface LayerControls {
  layer: Layer | null
  layerRef: React.MutableRefObject<Layer | null>
  /** Applies a change. Pass undoable false for background updates such as recognition results. */
  mutate: (change: (draft: Layer) => void, undoable?: boolean) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  flush: () => void
  /** While true, saving waits, so a stroke in progress is never interrupted by file work. */
  holdSaveRef: React.MutableRefObject<boolean>
  undoDepth: () => number
  /** Merges everything after the given depth into one undo step. */
  collapseUndo: (depth: number) => void
}

function copy(layer: Layer): Layer {
  return {
    annotations: {
      ...layer.annotations,
      targets: layer.annotations.targets.map((t) => ({ ...t })),
      marginNotes: layer.annotations.marginNotes.map((n) => ({ ...n }))
    },
    // Strokes never change once written, so sharing them keeps undo cheap.
    ink: { ...layer.ink, strokes: [...layer.ink.strokes] }
  }
}

export function useLayer(paperId: string | null): LayerControls {
  const [layer, setLayer] = useState<Layer | null>(null)
  const layerRef = useRef<Layer | null>(null)
  const undoStack = useRef<Layer[]>([])
  const redoStack = useRef<Layer[]>([])
  const [, setHistoryTick] = useState(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)
  const idRef = useRef(paperId)

  const holdSaveRef = useRef(false)
  const saveChain = useRef<Promise<unknown>>(Promise.resolve())

  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const id = idRef.current
    const snapshot = layerRef.current
    if (dirty.current && id && snapshot) {
      dirty.current = false
      // One save at a time, so an older one can never land after a newer one.
      saveChain.current = saveChain.current.then(() => window.api.saveLayer(id, snapshot)).catch(() => undefined)
    }
  }, [])

  const timedSave = useCallback(() => {
    if (holdSaveRef.current) saveTimer.current = setTimeout(timedSave, SAVE_DELAY_MS)
    else flush()
  }, [flush])

  useEffect(() => {
    idRef.current = paperId
    layerRef.current = null
    setLayer(null)
    undoStack.current = []
    redoStack.current = []
    if (!paperId) return
    let cancelled = false
    void window.api.loadLayer(paperId).then((l) => {
      if (cancelled) return
      layerRef.current = l
      setLayer(l)
    })
    return () => {
      cancelled = true
      flush()
    }
  }, [paperId, flush])

  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [flush])

  const apply = useCallback(
    (next: Layer) => {
      layerRef.current = next
      setLayer(next)
      dirty.current = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(timedSave, SAVE_DELAY_MS)
    },
    [timedSave]
  )

  const mutate = useCallback(
    (change: (draft: Layer) => void, undoable = true) => {
      const current = layerRef.current
      if (!current) return
      const next = copy(current)
      change(next)
      if (undoable) {
        undoStack.current.push(current)
        if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift()
        redoStack.current = []
        setHistoryTick((t) => t + 1)
      }
      apply(next)
    },
    [apply]
  )

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev || !layerRef.current) return
    redoStack.current.push(layerRef.current)
    setHistoryTick((t) => t + 1)
    apply(prev)
  }, [apply])

  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next || !layerRef.current) return
    undoStack.current.push(layerRef.current)
    setHistoryTick((t) => t + 1)
    apply(next)
  }, [apply])

  const undoDepth = useCallback(() => undoStack.current.length, [])
  const collapseUndo = useCallback((depth: number) => {
    if (undoStack.current.length > depth + 1) undoStack.current.length = depth + 1
  }, [])

  return {
    holdSaveRef,
    undoDepth,
    collapseUndo,
    layer,
    layerRef,
    mutate,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    flush
  }
}
