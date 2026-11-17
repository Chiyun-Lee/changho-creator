import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  dimGeom,
  edgeTargets,
  faceW,
  fmt,
  jointsOf,
  parallelOverlaps,
  rectOf,
  snapDelta,
  snapEnd,
  type Design,
  type Dim,
  type Dir,
  type Member,
} from './model'

interface Props {
  design: Design
  selection: Set<string>
  onSelect: (ids: Set<string>) => void
  tool: { stockId: string; face: 'a' | 'b' }
  onCommit: (members: Member[]) => void
  onDims: (dims: Dim[]) => void
}

interface Pt {
  x: number
  y: number
}

type Drag =
  | { kind: 'bg'; p0: Pt; sx: number; sy: number; id: string; dir: Dir | null }
  | { kind: 'move'; p0: Pt; ids: Set<string>; moved: boolean; copies: Member[] | null }
  | { kind: 'marquee'; p0: Pt }
  | { kind: 'dim'; id: string; dir: Dir }
  | { kind: 'resize'; id: string; end: 'min' | 'max' }

interface Draft {
  members: Member[]
  gx: number[]
  gy: number[]
}

const SNAP_PX = 8

export default function Canvas({ design, selection, onSelect, tool, onCommit, onDims }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const lastDimDown = useRef<{ id: string; t: number } | null>(null)
  const [view, setView] = useState({ x: 40, y: 40, scale: 1 })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dimDraft, setDimDraft] = useState<{ id: string; pos: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  // Fit the panel on first mount.
  useLayoutEffect(() => {
    const el = svgRef.current!
    const { width, height } = el.getBoundingClientRect()
    const scale = Math.min((width - 120) / design.panel.w, (height - 120) / design.panel.h)
    setView({
      scale,
      x: (width - design.panel.w * scale) / 2,
      y: (height - design.panel.h * scale) / 2,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Wheel: scroll pans, pinch / ctrl+scroll zooms about the cursor.
  useEffect(() => {
    const el = svgRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      setView((v) => {
        if (!e.ctrlKey && !e.metaKey) return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }
        const scale = Math.min(40, Math.max(0.1, v.scale * Math.exp(-e.deltaY * 0.01)))
        const k = scale / v.scale
        return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const toMm = (e: React.PointerEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - r.left - view.x) / view.scale,
      y: (e.clientY - r.top - view.y) / view.scale,
    }
  }
  const tol = SNAP_PX / view.scale
  const { stocks } = design

  /** Rects of members perpendicular to `dir`, excluding `ids`. */
  const perpRects = (dir: Dir, ids: Set<string>) =>
    design.members.filter((m) => m.dir !== dir && !ids.has(m.id)).map((m) => rectOf(m, stocks))

  const capture = (e: React.PointerEvent) => svgRef.current!.setPointerCapture(e.pointerId)

  const downBg = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    capture(e)
    if (e.shiftKey) {
      drag.current = { kind: 'marquee', p0: toMm(e) }
      return
    }
    drag.current = {
      kind: 'bg',
      p0: toMm(e),
      sx: e.clientX,
      sy: e.clientY,
      id: crypto.randomUUID(),
      dir: null,
    }
  }

  const downMember = (e: React.PointerEvent, m: Member) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (e.shiftKey) {
      const next = new Set(selection)
      if (next.has(m.id)) next.delete(m.id)
      else next.add(m.id)
      onSelect(next)
      return
    }
    const ids = selection.has(m.id) ? selection : new Set([m.id])
    if (ids !== selection) onSelect(ids)
    capture(e)
    // Option-drag leaves the originals in place and drags copies.
    const copies = e.altKey
      ? design.members.filter((x) => ids.has(x.id)).map((x) => ({ ...x, id: crypto.randomUUID() }))
      : null
    drag.current = { kind: 'move', p0: toMm(e), ids, moved: false, copies }
  }

  const downHandle = (e: React.PointerEvent, id: string, end: 'min' | 'max') => {
    if (e.button !== 0) return
    e.stopPropagation()
    capture(e)
    drag.current = { kind: 'resize', id, end }
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = toMm(e)

    if (d.kind === 'bg') {
      if (!d.dir) {
        const dx = e.clientX - d.sx
        const dy = e.clientY - d.sy
        if (Math.hypot(dx, dy) < 5) return
        d.dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'
      }
      const dir = d.dir
      const h = dir === 'h'
      const proto: Member = { id: d.id, stockId: tool.stockId, face: tool.face, dir, x: 0, y: 0, len: 1 }
      const fw = faceW(proto, stocks)
      const none = new Set<string>()
      const t = edgeTargets(design, none)
      // position across the member: centred on where the drag started
      let cross = (h ? d.p0.y : d.p0.x) - fw / 2
      const cs = snapDelta([cross, cross + fw], h ? t.ys : t.xs, tol)
      cross = cs ? cross + cs.delta : Math.round(cross)
      // both ends along the member
      const a0 = h ? d.p0.x : d.p0.y
      const a1 = h ? p.x : p.y
      const perp = perpRects(dir, none)
      const along = h ? t.xs : t.ys
      const range: [number, number] = [cross, cross + fw]
      const s0 = snapEnd(a0, a0 > a1, dir, range, perp, along, tol)
      const s1 = snapEnd(a1, a1 >= a0, dir, range, perp, along, tol)
      const lo = Math.min(s0.value, s1.value)
      const len = Math.abs(s1.value - s0.value)
      const m: Member = { ...proto, x: h ? lo : cross, y: h ? cross : lo, len }
      const gAlong = [s0.guide, s1.guide].filter((g): g is number => g !== undefined)
      const gCross = cs ? [cs.guide] : []
      setDraft({
        members: len >= 1 ? [...design.members, m] : design.members,
        gx: h ? gAlong : gCross,
        gy: h ? gCross : gAlong,
      })
      return
    }

    if (d.kind === 'dim') {
      setDimDraft({ id: d.id, pos: Math.round(d.dir === 'h' ? p.x : p.y) })
      return
    }

    if (d.kind === 'marquee') {
      setMarquee({
        x0: Math.min(d.p0.x, p.x),
        y0: Math.min(d.p0.y, p.y),
        x1: Math.max(d.p0.x, p.x),
        y1: Math.max(d.p0.y, p.y),
      })
      return
    }

    if (d.kind === 'move') {
      let dx = p.x - d.p0.x
      let dy = p.y - d.p0.y
      if (!d.moved && Math.hypot(dx, dy) * view.scale < 4) return
      d.moved = true
      const moving = d.copies ?? design.members.filter((m) => d.ids.has(m.id))
      const rects = moving.map((m) => rectOf(m, stocks))
      const t = edgeTargets(design, d.copies ? new Set() : d.ids)
      const sx = snapDelta(rects.flatMap((r) => [r.x0 + dx, r.x1 + dx]), t.xs, tol)
      const sy = snapDelta(rects.flatMap((r) => [r.y0 + dy, r.y1 + dy]), t.ys, tol)
      dx = sx ? dx + sx.delta : Math.round(dx)
      dy = sy ? dy + sy.delta : Math.round(dy)
      setDraft({
        members: d.copies
          ? [...design.members, ...d.copies.map((m) => ({ ...m, x: m.x + dx, y: m.y + dy }))]
          : design.members.map((m) => (d.ids.has(m.id) ? { ...m, x: m.x + dx, y: m.y + dy } : m)),
        gx: sx ? [sx.guide] : [],
        gy: sy ? [sy.guide] : [],
      })
      return
    }

    // resize
    const m = design.members.find((x) => x.id === d.id)
    if (!m) return
    const h = m.dir === 'h'
    const ids = new Set([m.id])
    const t = edgeTargets(design, ids)
    const r = rectOf(m, stocks)
    const range: [number, number] = h ? [r.y0, r.y1] : [r.x0, r.x1]
    const lo0 = h ? m.x : m.y
    const hi0 = lo0 + m.len
    const s = snapEnd(h ? p.x : p.y, d.end === 'max', m.dir, range, perpRects(m.dir, ids), h ? t.xs : t.ys, tol)
    const lo = d.end === 'min' ? Math.min(s.value, hi0 - 1) : lo0
    const hi = d.end === 'max' ? Math.max(s.value, lo0 + 1) : hi0
    const next: Member = { ...m, [h ? 'x' : 'y']: lo, len: hi - lo }
    const g = s.guide !== undefined ? [s.guide] : []
    setDraft({
      members: design.members.map((x) => (x.id === m.id ? next : x)),
      gx: h ? g : [],
      gy: h ? [] : g,
    })
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'dim') {
      if (dimDraft) {
        onDims((design.dims ?? []).map((x) => (x.id === dimDraft.id ? { ...x, pos: dimDraft.pos } : x)))
      }
      setDimDraft(null)
      return
    }
    if (d.kind === 'marquee') {
      if (marquee) {
        const next = new Set(selection)
        for (const m of design.members) {
          const r = rectOf(m, stocks)
          if (r.x0 < marquee.x1 && r.x1 > marquee.x0 && r.y0 < marquee.y1 && r.y1 > marquee.y0) {
            next.add(m.id)
          }
        }
        onSelect(next)
      }
      setMarquee(null)
      return
    }
    if (draft) {
      onCommit(draft.members)
      if (d.kind === 'move' && d.copies) onSelect(new Set(d.copies.map((m) => m.id)))
      if (d.kind === 'bg' && draft.members.length > design.members.length) onSelect(new Set([d.id]))
    } else if (d.kind === 'bg') {
      onSelect(new Set())
    }
    setDraft(null)
  }

  const shown: Design = draft ? { ...design, members: draft.members } : design
  const joints = jointsOf(shown)
  const overlaps = parallelOverlaps(shown)
  const px = 1 / view.scale // one screen pixel in mm
  const dash = `${4 * px} ${3 * px}`
  const dots = `${2.5 * px} ${2.5 * px}`
  const single = selection.size === 1 ? shown.members.find((m) => selection.has(m.id)) : undefined
  const { w: W, h: H } = design.panel

  return (
    <svg
      ref={svgRef}
      className="canvas"
      onPointerDown={downBg}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
        <rect className="hanji" x={0} y={0} width={W} height={H} strokeWidth={px} strokeDasharray={dash} />
        <text className="dim" x={W / 2} y={-8 * px} fontSize={12 * px} textAnchor="middle">
          {fmt(W)} mm
        </text>
        <text
          className="dim"
          x={-8 * px}
          y={H / 2}
          fontSize={12 * px}
          textAnchor="middle"
          transform={`rotate(-90 ${-8 * px} ${H / 2})`}
        >
          {fmt(H)} mm
        </text>

        {shown.members.map((m) => {
          const r = rectOf(m, stocks)
          const cls =
            'member' + (selection.has(m.id) ? ' selected' : '') + (overlaps.has(m.id) ? ' bad' : '')
          return (
            <g key={m.id}>
              <rect
                className={cls}
                x={r.x0}
                y={r.y0}
                width={r.x1 - r.x0}
                height={r.y1 - r.y0}
                strokeWidth={px}
                onPointerDown={(e) => downMember(e, m)}
              />
            </g>
          )
        })}

        {/* Overlaps: shaded, with dotted lines where one stick's edge runs under or over the other */}
        {joints.map((j, i) => (
          <g key={i} className="joint">
            <rect x={j.r.x0} y={j.r.y0} width={j.r.x1 - j.r.x0} height={j.r.y1 - j.r.y0} />
            {j.edges.map((e, k) => (
              <line
                key={k}
                x1={e.line[0]}
                y1={e.line[1]}
                x2={e.line[2]}
                y2={e.line[3]}
                strokeWidth={px}
                strokeDasharray={e.hidden ? dots : undefined}
              />
            ))}
          </g>
        ))}

        {(design.dims ?? []).map((dim) => {
          const g = dimGeom(shown, dimDraft?.id === dim.id ? { ...dim, pos: dimDraft.pos } : dim)
          if (!g) return null
          const h = g.dir === 'h' // horizontal members: the marker line runs vertically
          // (along, across) -> (x, y)
          const pt = (along: number, across: number) => (h ? [along, across] : [across, along])
          const seg = (a: number[], b: number[], key: string, cls = 'dim-line') => (
            <line
              key={key}
              className={cls}
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              strokeWidth={px}
              strokeDasharray={cls === 'dim-ext' ? dash : undefined}
            />
          )
          const tick = 5 * px
          const mid = (g.from + g.to) / 2
          const [tx, ty] = h ? [g.pos + 7 * px, mid + 4 * px] : [mid, g.pos - 7 * px]
          return (
            <g
              key={dim.id}
              className="dim-marker"
              style={{ cursor: h ? 'ew-resize' : 'ns-resize' }}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                // Double-click removes the marker. This is timed by hand because
                // pointer capture sends the browser's own dblclick to the canvas.
                const last = lastDimDown.current
                lastDimDown.current = { id: dim.id, t: e.timeStamp }
                if (last && last.id === dim.id && e.timeStamp - last.t < 400) {
                  lastDimDown.current = null
                  onDims((design.dims ?? []).filter((x) => x.id !== dim.id))
                  return
                }
                capture(e)
                drag.current = { kind: 'dim', id: dim.id, dir: g.dir }
              }}
            >
              <title>Drag to move. Double-click to remove.</title>
              {g.ext.map((x, i) => seg(pt(x.from, x.at), pt(x.to, x.at), 'e' + i, 'dim-ext'))}
              {seg(pt(g.pos, g.from), pt(g.pos, g.to), 'l')}
              {seg(pt(g.pos - tick, g.from), pt(g.pos + tick, g.from), 't0')}
              {seg(pt(g.pos - tick, g.to), pt(g.pos + tick, g.to), 't1')}
              {/* wide invisible line so the marker is easy to grab */}
              <line
                className="dim-hit"
                x1={pt(g.pos, g.from)[0]}
                y1={pt(g.pos, g.from)[1]}
                x2={pt(g.pos, g.to)[0]}
                y2={pt(g.pos, g.to)[1]}
                strokeWidth={14 * px}
              />
              <text
                className="dim-text"
                x={tx}
                y={ty}
                fontSize={12 * px}
                strokeWidth={3 * px}
                textAnchor={h ? 'start' : 'middle'}
              >
                {fmt(g.dist)} mm
              </text>
            </g>
          )
        })}

        {single &&
          (() => {
            const r = rectOf(single, stocks)
            const h = single.dir === 'h'
            const s = 9 * px
            const cx = (r.x0 + r.x1) / 2
            const cy = (r.y0 + r.y1) / 2
            const ends: ['min' | 'max', number, number][] = h
              ? [['min', r.x0, cy], ['max', r.x1, cy]]
              : [['min', cx, r.y0], ['max', cx, r.y1]]
            return (
              <>
                {ends.map(([end, x, y]) => (
                  <rect
                    key={end}
                    className={'handle ' + (h ? 'ew' : 'ns')}
                    x={x - s / 2}
                    y={y - s / 2}
                    width={s}
                    height={s}
                    strokeWidth={px}
                    onPointerDown={(e) => downHandle(e, single.id, end)}
                  />
                ))}
                <text
                  className="len"
                  x={h ? cx : r.x1 + 6 * px}
                  y={h ? r.y0 - 6 * px : cy}
                  fontSize={12 * px}
                  textAnchor={h ? 'middle' : 'start'}
                >
                  {fmt(single.len)} mm
                </text>
              </>
            )
          })()}

        {marquee && (
          <rect
            className="marquee"
            strokeDasharray={dash}
            x={marquee.x0}
            y={marquee.y0}
            width={marquee.x1 - marquee.x0}
            height={marquee.y1 - marquee.y0}
            strokeWidth={px}
          />
        )}
        {draft?.gx.map((x, i) => (
          <line key={'x' + i} className="guide" x1={x} x2={x} y1={-1e4} y2={1e4} strokeWidth={px} strokeDasharray={dash} />
        ))}
        {draft?.gy.map((y, i) => (
          <line key={'y' + i} className="guide" y1={y} y2={y} x1={-1e4} x2={1e4} strokeWidth={px} strokeDasharray={dash} />
        ))}
      </g>
    </svg>
  )
}
