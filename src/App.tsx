import { useCallback, useEffect, useRef, useState } from 'react'
import Canvas from './Canvas'
import RoomView from './RoomView'
import { exportPdf } from './exportPdf'
import {
  cutList,
  cutListText,
  defaultDimPos,
  distribute,
  fmt,
  notchText,
  parallelOverlaps,
  type Design,
  type Member,
  type Stock,
} from './model'

const STORAGE_KEY = 'changho-design-v1'

const DEFAULT: Design = {
  panel: { w: 600, h: 900 },
  stocks: [
    { id: 's5x5', a: 5, b: 5 },
    { id: 's11x5', a: 11, b: 5 },
  ],
  members: [],
}

function load(): Design {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Design
  } catch {
    // fall through to the default design
  }
  return DEFAULT
}

interface History {
  past: Design[]
  present: Design
  future: Design[]
}

/** Text field that commits a positive-or-any number on blur or Enter. */
function Num({
  value,
  onChange,
  min,
}: {
  value: number
  onChange: (n: number) => void
  min?: number
}) {
  const [text, setText] = useState(fmt(value))
  useEffect(() => setText(fmt(value)), [value])
  const commit = () => {
    const n = parseFloat(text)
    if (Number.isFinite(n) && (min === undefined || n >= min)) onChange(n)
    else setText(fmt(value))
  }
  return (
    <input
      className="num"
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

export default function App() {
  const [hist, setHist] = useState<History>(() => ({ past: [], present: load(), future: [] }))
  const design = hist.present
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [tool, setTool] = useState<{ stockId: string; face: 'a' | 'b' }>(() => ({
    stockId: design.stocks[0]?.id ?? '',
    face: 'a',
  }))
  const [newStock, setNewStock] = useState({ a: 8, b: 5 })
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<'room' | 'design'>('design')

  const commit = useCallback((next: Design) => {
    setHist((h) => ({ past: [...h.past.slice(-99), h.present], present: next, future: [] }))
  }, [])
  const undo = useCallback(() => {
    setHist((h) =>
      h.past.length
        ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
        : h,
    )
  }, [])
  const redo = useCallback(() => {
    setHist((h) =>
      h.future.length
        ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
        : h,
    )
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(design))
    } catch {
      // storage unavailable: the design just won't persist
    }
  }, [design])

  const setMembers = useCallback(
    (members: Member[]) => {
      // Distance markers go when either of their pieces is deleted.
      const ids = new Set(members.map((m) => m.id))
      const dims = design.dims?.filter((d) => ids.has(d.a) && ids.has(d.b))
      commit({ ...design, members, dims })
    },
    [commit, design],
  )
  const patchSelected = (fn: (m: Member) => Member) =>
    setMembers(design.members.map((m) => (selection.has(m.id) ? fn(m) : m)))

  const remove = useCallback(() => {
    if (!selection.size) return
    setMembers(design.members.filter((m) => !selection.has(m.id)))
    setSelection(new Set())
  }, [design.members, selection, setMembers])

  /** Add copies of `source`, shifted by (dx, dy), and select them. */
  const addCopies = useCallback(
    (source: Member[], dx: number, dy: number) => {
      if (!source.length) return
      const copies = source.map((m) => ({ ...m, id: crypto.randomUUID(), x: m.x + dx, y: m.y + dy }))
      setMembers([...design.members, ...copies])
      setSelection(new Set(copies.map((m) => m.id)))
    },
    [design.members, setMembers],
  )

  const duplicate = useCallback(
    () => addCopies(design.members.filter((m) => selection.has(m.id)), 20, 20),
    [addCopies, design.members, selection],
  )

  // Copied pieces; each paste lands 20 mm further along so pastes don't stack.
  const clipboard = useRef<{ members: Member[]; pastes: number }>({ members: [], pastes: 0 })
  const copy = useCallback(() => {
    const members = design.members.filter((m) => selection.has(m.id))
    if (members.length) clipboard.current = { members, pastes: 0 }
  }, [design.members, selection])
  const paste = useCallback(() => {
    const clip = clipboard.current
    const off = 20 * ++clip.pastes
    addCopies(clip.members, off, off)
  }, [addCopies])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (view !== 'design') {
        return
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        duplicate()
      } else if (mod && e.key.toLowerCase() === 'c') {
        copy()
      } else if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        paste()
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelection(new Set(design.members.map((m) => m.id)))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        remove()
      } else if (e.key.startsWith('Arrow') && selection.size) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        setMembers(
          design.members.map((m) => (selection.has(m.id) ? { ...m, x: m.x + dx, y: m.y + dy } : m)),
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copy, design.members, duplicate, paste, redo, remove, selection, setMembers, undo, view])

  const stockLabel = (s: Stock) => `${fmt(s.a)}×${fmt(s.b)} mm`
  const usedStocks = new Set(design.members.map((m) => m.stockId))
  const toolStock = design.stocks.find((s) => s.id === tool.stockId)
  const selected = design.members.filter((m) => selection.has(m.id))
  const one = selected.length === 1 ? selected[0] : undefined
  const canDistribute = selected.length >= 3 && selected.every((m) => m.dir === selected[0].dir)
  const canMeasure = selected.length === 2 && selected[0].dir === selected[1].dir
  const measure = () => {
    const [a, b] = selected
    const pos = defaultDimPos(design, a.id, b.id)
    if (pos === null) return
    commit({
      ...design,
      dims: [...(design.dims ?? []), { id: crypto.randomUUID(), a: a.id, b: b.id, pos }],
    })
  }
  const rows = cutList(design)
  const overlapCount = parallelOverlaps(design).size

  const addStock = () => {
    const s: Stock = { id: crypto.randomUUID(), a: newStock.a, b: newStock.b }
    commit({ ...design, stocks: [...design.stocks, s] })
    setTool({ stockId: s.id, face: 'a' })
  }

  const faceButtons = (s: Stock, face: 'a' | 'b', set: (f: 'a' | 'b') => void) =>
    s.a === s.b ? null : (
      <div className="seg">
        {(['a', 'b'] as const).map((f) => (
          <button key={f} className={face === f ? 'on' : ''} onClick={() => set(f)}>
            {fmt(s[f])} mm face
          </button>
        ))}
      </div>
    )

  return (
    <div className="app">
      <aside className="side">
        <h1>Changho Creator</h1>
        <div className="seg tabs">
          <button className={view === 'room' ? 'on' : ''} onClick={() => setView('room')}>
            Room
          </button>
          <button className={view === 'design' ? 'on' : ''} onClick={() => setView('design')}>
            Design
          </button>
        </div>

        <section>
          <h2>Panel (mm)</h2>
          <div className="row">
            <label>
              W{' '}
              <Num
                value={design.panel.w}
                min={1}
                onChange={(w) => commit({ ...design, panel: { ...design.panel, w } })}
              />
            </label>
            <label>
              H{' '}
              <Num
                value={design.panel.h}
                min={1}
                onChange={(h) => commit({ ...design, panel: { ...design.panel, h } })}
              />
            </label>
          </div>
        </section>

        <section>
          <h2>Wood stock (mm)</h2>
          <ul className="stocks">
            {design.stocks.map((s) => (
              <li key={s.id}>
                <button
                  className={'stock' + (tool.stockId === s.id ? ' on' : '')}
                  onClick={() => setTool({ stockId: s.id, face: 'a' })}
                >
                  {stockLabel(s)}
                </button>
                <button
                  className="x"
                  title={usedStocks.has(s.id) ? 'In use' : 'Remove'}
                  disabled={usedStocks.has(s.id) || design.stocks.length === 1}
                  onClick={() => {
                    const stocks = design.stocks.filter((x) => x.id !== s.id)
                    commit({ ...design, stocks })
                    if (tool.stockId === s.id) setTool({ stockId: stocks[0].id, face: 'a' })
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            <Num value={newStock.a} min={0.1} onChange={(a) => setNewStock({ ...newStock, a })} />
            ×
            <Num value={newStock.b} min={0.1} onChange={(b) => setNewStock({ ...newStock, b })} />
            mm
            <button onClick={addStock}>Add</button>
          </div>
          {toolStock && faceButtons(toolStock, tool.face, (face) => setTool({ ...tool, face }))}
          <p className="hint">Drag on the panel to draw a piece with the selected stock.</p>
        </section>

        <section>
          <h2>Selection</h2>
          {!selected.length && <p className="hint">
              Click a piece. Shift-click to add or remove one, or Shift-drag on empty space to box-select
              several.
            </p>}
          {one && (
            <>
              <div className="row">
                <select
                  value={one.stockId}
                  onChange={(e) => patchSelected((m) => ({ ...m, stockId: e.target.value, face: 'a' }))}
                >
                  {design.stocks.map((s) => (
                    <option key={s.id} value={s.id}>
                      {stockLabel(s)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => patchSelected((m) => ({ ...m, dir: m.dir === 'h' ? 'v' : 'h' }))}
                >
                  Rotate
                </button>
              </div>
              {(() => {
                const s = design.stocks.find((x) => x.id === one.stockId)
                return s ? faceButtons(s, one.face, (face) => patchSelected((m) => ({ ...m, face }))) : null
              })()}
              <div className="row">
                <label>
                  X <Num value={one.x} onChange={(x) => patchSelected((m) => ({ ...m, x }))} /> mm
                </label>
                <label>
                  Y <Num value={one.y} onChange={(y) => patchSelected((m) => ({ ...m, y }))} /> mm
                </label>
              </div>
              <div className="row">
                <label>
                  Length{' '}
                  <Num value={one.len} min={1} onChange={(len) => patchSelected((m) => ({ ...m, len }))} /> mm
                </label>
              </div>
            </>
          )}
          {selected.length > 1 && <p className="hint">{selected.length} pieces selected.</p>}
          {selected.length > 0 && (
            <p className="hint">⌘C / ⌘V to copy and paste, or hold Option and drag to pull out a copy.</p>
          )}
          {selected.length > 0 && (
            <div className="row">
              <button onClick={duplicate}>Duplicate</button>
              <button onClick={remove}>Delete</button>
              {canDistribute && (
                <button onClick={() => setMembers(distribute(design, selection))}>Space evenly</button>
              )}
              {canMeasure && <button onClick={measure}>Mark distance</button>}
            </div>
          )}
        </section>

        <section>
          <div className="row">
            <button onClick={undo} disabled={!hist.past.length}>
              Undo
            </button>
            <button onClick={redo} disabled={!hist.future.length}>
              Redo
            </button>
          </div>
        </section>
      </aside>

      {view === 'design' ? (
        <Canvas
          design={design}
          selection={selection}
          onSelect={setSelection}
          tool={tool}
          onCommit={setMembers}
          onDims={(dims) => commit({ ...design, dims })}
        />
      ) : (
        <RoomView
          design={design}
          onPlace={(placement, size) =>
            commit({ ...design, placement, panel: size ?? design.panel })
          }
          onScanReplaced={() => {
            if (design.placement) commit({ ...design, placement: undefined })
          }}
        />
      )}

      <aside className="side right">
        <div className="row spread">
          <h2>Cut list</h2>
          <button
            disabled={!rows.length}
            onClick={async () => {
              await navigator.clipboard.writeText(cutListText(design))
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <button
          className="wide"
          disabled={!design.members.length}
          onClick={() => exportPdf(design, selection)}
        >
          {selected.length
            ? `Export PDF of ${selected.length} selected`
            : 'Export PDF of all pieces'}
        </button>
        {overlapCount > 0 && (
          <p className="warn">
            {overlapCount} pieces overlap another piece running the same way (shown in red).
          </p>
        )}
        {!rows.length && <p className="hint">No pieces yet.</p>}
        {rows.map((r, i) => (
          <div
            key={i}
            className={'cut' + (r.ids.some((id) => selection.has(id)) ? ' on' : '')}
            onClick={() => setSelection(new Set(r.ids))}
          >
            <div className="cut-head">
              <b>{r.qty} ×</b> {fmt(r.len)} mm
              <span className="muted">
                {' '}
                {r.stock} mm, {fmt(r.faceW)} mm face
              </span>
            </div>
            {r.notches.map((n, j) => (
              <div key={j} className="notch">
                notch {notchText(n)}
              </div>
            ))}
          </div>
        ))}
        {rows.length > 0 && (
          <p className="hint">
            Notch positions are measured from the left end of horizontal pieces and the top end of
            vertical pieces. "Back" is the hanji side.
          </p>
        )}
      </aside>
    </div>
  )
}
