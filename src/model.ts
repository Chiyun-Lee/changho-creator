// All dimensions are millimetres. The design plane is x right, y down,
// with the origin at the top-left of the outlined panel area.
// The back of every member sits on the same plane (the hanji side).

export type Dir = 'h' | 'v'

/** A stock cross-section, a x b mm. */
export interface Stock {
  id: string
  a: number
  b: number
}

export interface Member {
  id: string
  stockId: string
  /** Which stock dimension is the visible face; the other is the depth. */
  face: 'a' | 'b'
  dir: Dir
  /** Top-left corner of the member's visible face. */
  x: number
  y: number
  len: number
}

/** Where the panel hangs in the room scan (metres, Y up). */
export interface Placement {
  /** Centre of the panel on the wall plane. */
  c: number[]
  /** Horizontal wall normal (x, z), pointing into the room. */
  n: [number, number]
}

export interface Design {
  panel: { w: number; h: number }
  stocks: Stock[]
  members: Member[]
  placement?: Placement
  dims?: Dim[]
}

/** A distance marker between two parallel members. */
export interface Dim {
  id: string
  a: string
  b: string
  /** Where the marker sits along the members: x for horizontals, y for verticals. */
  pos: number
}

export interface DimGeom {
  /** Direction of the two members; the distance is measured across it. */
  dir: Dir
  /** Facing edges of the two members, on the measuring axis. */
  from: number
  to: number
  dist: number
  pos: number
  /** Extension lines from a member's end out to the marker. */
  ext: { at: number; from: number; to: number }[]
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Notch {
  /** Distance from the member's left (h) or top (v) end to the notch start. */
  pos: number
  width: number
  depth: number
  /** 'back' is the hanji side. */
  side: 'front' | 'back'
}

export interface CutRow {
  qty: number
  stock: string
  faceW: number
  depth: number
  len: number
  notches: Notch[]
  ids: string[]
}

const EPS = 1e-6

export const fmt = (n: number) => String(Math.round(n * 10) / 10)

function stockOf(m: Member, stocks: Stock[]): Stock {
  return stocks.find((s) => s.id === m.stockId) ?? { id: '', a: 5, b: 5 }
}

export function faceW(m: Member, stocks: Stock[]): number {
  const s = stockOf(m, stocks)
  return m.face === 'a' ? s.a : s.b
}

export function depthOf(m: Member, stocks: Stock[]): number {
  const s = stockOf(m, stocks)
  return m.face === 'a' ? s.b : s.a
}

export function rectOf(m: Member, stocks: Stock[]): Rect {
  const w = faceW(m, stocks)
  return m.dir === 'h'
    ? { x0: m.x, y0: m.y, x1: m.x + m.len, y1: m.y + w }
    : { x0: m.x, y0: m.y, x1: m.x + w, y1: m.y + m.len }
}

function intersect(a: Rect, b: Rect): Rect | null {
  const r = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  }
  return r.x1 - r.x0 > EPS && r.y1 - r.y0 > EPS ? r : null
}

/**
 * Half-lap notches for every crossing of a horizontal and a vertical member.
 * Both notches are half the depth of the shallower member, and backs stay
 * flush. With equal depths the horizontal is notched on the front and the
 * vertical on the back. With unequal depths the shallower member takes the
 * front notch whichever way it runs: the other way round would need a deep
 * slot or a hole through the deeper member.
 */
export function notchesOf(design: Design): Map<string, Notch[]> {
  const out = new Map<string, Notch[]>()
  for (const m of design.members) out.set(m.id, [])
  const hs = design.members.filter((m) => m.dir === 'h')
  const vs = design.members.filter((m) => m.dir === 'v')
  for (const h of hs) {
    for (const v of vs) {
      const r = intersect(rectOf(h, design.stocks), rectOf(v, design.stocks))
      if (!r) continue
      const dh = depthOf(h, design.stocks)
      const dv = depthOf(v, design.stocks)
      const depth = Math.min(dh, dv) / 2
      const hFront = dh <= dv
      out.get(h.id)!.push({
        pos: r.x0 - h.x,
        width: r.x1 - r.x0,
        depth,
        side: hFront ? 'front' : 'back',
      })
      out.get(v.id)!.push({
        pos: r.y0 - v.y,
        width: r.y1 - r.y0,
        depth,
        side: hFront ? 'back' : 'front',
      })
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.pos - b.pos)
  return out
}

/** Ids of members that overlap another member running the same direction. */
export function parallelOverlaps(design: Design): Set<string> {
  const bad = new Set<string>()
  const ms = design.members
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      if (ms[i].dir !== ms[j].dir) continue
      if (intersect(rectOf(ms[i], design.stocks), rectOf(ms[j], design.stocks))) {
        bad.add(ms[i].id)
        bad.add(ms[j].id)
      }
    }
  }
  return bad
}

export function cutList(design: Design): CutRow[] {
  const notches = notchesOf(design)
  const rows = new Map<string, CutRow>()
  for (const m of design.members) {
    const s = stockOf(m, design.stocks)
    const ns = notches.get(m.id) ?? []
    const key = [
      m.stockId,
      m.face,
      fmt(m.len),
      ...ns.map((n) => `${fmt(n.pos)}/${fmt(n.width)}/${fmt(n.depth)}/${n.side}`),
    ].join('|')
    const row = rows.get(key)
    if (row) {
      row.qty++
      row.ids.push(m.id)
    } else {
      rows.set(key, {
        qty: 1,
        stock: `${fmt(s.a)}×${fmt(s.b)}`,
        faceW: faceW(m, design.stocks),
        depth: depthOf(m, design.stocks),
        len: m.len,
        notches: ns,
        ids: [m.id],
      })
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.stock.localeCompare(b.stock) || b.len - a.len,
  )
}

export function notchText(n: Notch): string {
  return `${fmt(n.pos)} → ${fmt(n.pos + n.width)} mm (${fmt(n.depth)} mm deep, ${n.side})`
}

export function cutListText(design: Design): string {
  const lines = cutList(design).map((r) => {
    const head = `${r.qty} × ${r.stock} mm, ${fmt(r.faceW)} mm face, length ${fmt(r.len)} mm`
    if (!r.notches.length) return head
    return `${head}\n` + r.notches.map((n) => `    notch ${notchText(n)}`).join('\n')
  })
  return lines.join('\n')
}

// ---------- snapping ----------

export interface Snap {
  value: number
  guide?: number
}

/** Shift that brings one of `values` onto the nearest target within `tol`. */
export function snapDelta(
  values: number[],
  targets: number[],
  tol: number,
): { delta: number; guide: number } | null {
  let best: { delta: number; guide: number } | null = null
  for (const v of values) {
    for (const t of targets) {
      const d = t - v
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) {
        best = { delta: d, guide: t }
      }
    }
  }
  return best
}

/**
 * Snap the end of a member along its own axis.
 * If the end touches or lands inside a crossing member, it goes to that
 * member's far edge, so T and L joints always overlap by the full width.
 */
export function snapEnd(
  v: number,
  isMax: boolean,
  dir: Dir,
  cross: [number, number],
  perp: Rect[],
  targets: number[],
  tol: number,
): Snap {
  for (const r of perp) {
    const [lo, hi] = dir === 'h' ? [r.x0, r.x1] : [r.y0, r.y1]
    const [c0, c1] = dir === 'h' ? [r.y0, r.y1] : [r.x0, r.x1]
    if (cross[0] < c1 - EPS && cross[1] > c0 + EPS && v > lo - tol && v < hi + tol) {
      const value = isMax ? hi : lo
      return { value, guide: value }
    }
  }
  const s = snapDelta([v], targets, tol)
  return s ? { value: s.guide, guide: s.guide } : { value: Math.round(v) }
}

export function edgeTargets(design: Design, excludeIds: Set<string>) {
  const xs = [0, design.panel.w]
  const ys = [0, design.panel.h]
  for (const m of design.members) {
    if (excludeIds.has(m.id)) continue
    const r = rectOf(m, design.stocks)
    xs.push(r.x0, r.x1)
    ys.push(r.y0, r.y1)
  }
  return { xs, ys }
}

/** Space the selected same-direction members so the gaps between them are equal. */
export function distribute(design: Design, ids: Set<string>): Member[] {
  const sel = design.members.filter((m) => ids.has(m.id))
  if (sel.length < 3 || sel.some((m) => m.dir !== sel[0].dir)) return design.members
  const key = sel[0].dir === 'h' ? 'y' : 'x'
  const sorted = [...sel].sort((a, b) => a[key] - b[key])
  const widths = sorted.map((m) => faceW(m, design.stocks))
  const first = sorted[0][key]
  const last = sorted[sorted.length - 1][key] + widths[widths.length - 1]
  const gap = (last - first - widths.reduce((a, b) => a + b, 0)) / (sorted.length - 1)
  const pos = new Map<string, number>()
  let cur = first
  sorted.forEach((m, i) => {
    pos.set(m.id, Math.round(cur * 10) / 10)
    cur += widths[i] + gap
  })
  return design.members.map((m) => (pos.has(m.id) ? { ...m, [key]: pos.get(m.id)! } : m))
}

// ---------- distance markers ----------

/** Across-range and along-range of a member, as [c0, c1, s0, s1]. */
function ranges(m: Member, stocks: Stock[]) {
  const r = rectOf(m, stocks)
  return m.dir === 'h' ? [r.y0, r.y1, r.x0, r.x1] : [r.x0, r.x1, r.y0, r.y1]
}

function dimPair(design: Design, a: string, b: string) {
  const A = design.members.find((m) => m.id === a)
  const B = design.members.find((m) => m.id === b)
  if (!A || !B || A === B || A.dir !== B.dir) return null
  const ra = ranges(A, design.stocks)
  const rb = ranges(B, design.stocks)
  const [first, second] = ra[0] <= rb[0] ? [ra, rb] : [rb, ra]
  return { dir: A.dir, first, second }
}

/** A sensible starting spot for a marker: the middle of where the two members run side by side. */
export function defaultDimPos(design: Design, a: string, b: string): number | null {
  const p = dimPair(design, a, b)
  return p ? (Math.max(p.first[2], p.second[2]) + Math.min(p.first[3], p.second[3])) / 2 : null
}

/** Null when a member is gone or the two are no longer parallel. */
export function dimGeom(design: Design, dim: Dim): DimGeom | null {
  const p = dimPair(design, dim.a, dim.b)
  if (!p) return null
  const from = p.first[1]
  const to = Math.max(from, p.second[0])
  const ext: DimGeom['ext'] = []
  for (const [at, r] of [[from, p.first], [to, p.second]] as const) {
    if (dim.pos < r[2]) ext.push({ at, from: dim.pos, to: r[2] })
    else if (dim.pos > r[3]) ext.push({ at, from: r[3], to: dim.pos })
  }
  return { dir: p.dir, from, to, dist: to - from, pos: dim.pos, ext }
}

// ---------- overlaps, for drawing ----------

export interface Joint {
  /** The area where a horizontal and a vertical member overlap. */
  r: Rect
  /** Each side of that area as a line: [x1, y1, x2, y2]. */
  edges: { line: [number, number, number, number]; hidden: boolean }[]
}

/**
 * Where members cross, and which sides of each crossing are hidden edges.
 * A side is hidden when it is the edge of only one member, so it runs across
 * the face of the other; it is a true outline when both members end there.
 */
export function jointsOf(design: Design): Joint[] {
  const out: Joint[] = []
  const near = (a: number, b: number) => Math.abs(a - b) < EPS
  for (const h of design.members) {
    if (h.dir !== 'h') continue
    const a = rectOf(h, design.stocks)
    for (const v of design.members) {
      if (v.dir !== 'v') continue
      const b = rectOf(v, design.stocks)
      const r = intersect(a, b)
      if (!r) continue
      out.push({
        r,
        edges: [
          { line: [r.x0, r.y0, r.x0, r.y1], hidden: !near(a.x0, b.x0) },
          { line: [r.x1, r.y0, r.x1, r.y1], hidden: !near(a.x1, b.x1) },
          { line: [r.x0, r.y0, r.x1, r.y0], hidden: !near(a.y0, b.y0) },
          { line: [r.x0, r.y1, r.x1, r.y1], hidden: !near(a.y1, b.y1) },
        ],
      })
    }
  }
  return out
}

// ---------- assembly order ----------

/**
 * The order sticks go together, front face up, each dropped straight onto
 * the ones already down. At every joint the stick notched on the front lies
 * underneath, and that is always the thinner one, or the horizontal when
 * they are equally thick. Sorting by thickness and then horizontals before
 * verticals therefore puts the under stick first at every joint, so nothing
 * ever has to be woven.
 */
export function assemblySteps(design: Design, members: Member[]) {
  const steps = new Map<string, { depth: number; dir: Dir; members: Member[] }>()
  for (const m of members) {
    const depth = depthOf(m, design.stocks)
    const key = `${depth}|${m.dir}`
    const step = steps.get(key) ?? { depth, dir: m.dir, members: [] }
    step.members.push(m)
    steps.set(key, step)
  }
  return [...steps.values()].sort(
    (a, b) => a.depth - b.depth || (a.dir === b.dir ? 0 : a.dir === 'h' ? -1 : 1),
  )
}
