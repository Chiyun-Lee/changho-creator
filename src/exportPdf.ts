import type { jsPDF } from 'jspdf'
import { assemblySteps, depthOf, faceW, fmt, jointsOf, notchesOf, rectOf, type Design, type Member, type Notch } from './model'

/** One kind of stick: every member with the same stock, length and notches. */
export interface StickType {
  letter: string
  members: Member[]
  stock: string
  faceW: number
  depth: number
  len: number
  notches: Notch[]
}

/** A, B, … Z, AA, AB, … */
export function letterFor(i: number): string {
  let s = ''
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s
  return s
}

/**
 * Group the chosen members into lettered stick types. Notches come from the
 * whole design, so a stick keeps the joints it shares with unselected pieces.
 * Letters run through the horizontals top to bottom, then the verticals left
 * to right.
 */
export function stickTypes(design: Design, chosen: Member[]): StickType[] {
  const notches = notchesOf(design)
  const ordered = [...chosen].sort((a, b) =>
    a.dir !== b.dir
      ? a.dir === 'h'
        ? -1
        : 1
      : a.dir === 'h'
        ? a.y - b.y || a.x - b.x
        : a.x - b.x || a.y - b.y,
  )
  const types = new Map<string, StickType>()
  for (const m of ordered) {
    const ns = notches.get(m.id) ?? []
    const key = [
      m.stockId,
      m.face,
      fmt(m.len),
      ...ns.map((n) => `${fmt(n.pos)}/${fmt(n.width)}/${fmt(n.depth)}/${n.side}`),
    ].join('|')
    const t = types.get(key)
    if (t) {
      t.members.push(m)
      continue
    }
    const s = design.stocks.find((x) => x.id === m.stockId)
    types.set(key, {
      letter: letterFor(types.size),
      members: [m],
      stock: s ? `${fmt(s.a)}×${fmt(s.b)}` : '?',
      faceW: faceW(m, design.stocks),
      depth: depthOf(m, design.stocks),
      len: m.len,
      notches: ns,
    })
  }
  return [...types.values()]
}

const PAGE_W = 297
const PAGE_H = 210
const M = 12
const WOOD: [number, number, number] = [240, 225, 200]

function drawAssembly(doc: jsPDF, design: Design, chosen: Member[], types: StickType[]) {
  const letterOf = new Map<string, string>()
  for (const t of types) for (const m of t.members) letterOf.set(m.id, t.letter)
  const chosenIds = new Set(chosen.map((m) => m.id))
  const rects = chosen.map((m) => rectOf(m, design.stocks))
  const bx0 = Math.min(...rects.map((r) => r.x0))
  const by0 = Math.min(...rects.map((r) => r.y0))
  const bx1 = Math.max(...rects.map((r) => r.x1))
  const by1 = Math.max(...rects.map((r) => r.y1))

  // The order to put the sticks together, written above the drawing.
  const steps = assemblySteps(design, chosen).map((step, i) => {
    const letters = [...new Set(step.members.map((m) => letterOf.get(m.id) ?? ''))]
    return `${i + 1}. ${step.dir === 'h' ? 'horizontal' : 'vertical'} sticks ${fmt(step.depth)} mm thick: ${letters.join(', ')}`
  })
  doc.setFont('helvetica', 'normal').setFontSize(8)
  const order: string[] = [
    'Assembly: lay the sticks down with the front face up, in this order. Each one drops straight onto those already down, so nothing needs weaving.',
    ...steps.map((line) => `    ${line}`),
  ]
  doc.setTextColor(20)
  doc.text(order, M, 33)

  // Drawing area
  const pad = 8
  const top = 32 + order.length * 3.6
  const areaW = PAGE_W - 2 * M - 2 * pad
  const areaH = PAGE_H - top - M - 2 * pad
  const s = Math.min(1, areaW / (bx1 - bx0), areaH / (by1 - by0))
  const ox = M + pad + (areaW - (bx1 - bx0) * s) / 2
  const oy = top + pad
  const X = (x: number) => ox + (x - bx0) * s
  const Y = (y: number) => oy + (y - by0) * s

  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(110)
  doc.text(
    `Seen from the front. Drawn at 1:${fmt(1 / s)}. Each letter sits on the stick it names; sticks with the same letter are identical. Dotted lines show where sticks overlap.` +
      (chosen.length < design.members.length ? ' Pieces not in this export are shown in grey.' : ''),
    M,
    28,
  )

  doc.setLineWidth(0.15)
  // Unselected neighbours, clipped to the drawing's bounds, for context.
  doc.setDrawColor(190)
  for (const m of design.members) {
    if (chosenIds.has(m.id)) continue
    const r = rectOf(m, design.stocks)
    const x0 = Math.max(r.x0, bx0)
    const y0 = Math.max(r.y0, by0)
    const x1 = Math.min(r.x1, bx1)
    const y1 = Math.min(r.y1, by1)
    if (x1 > x0 && y1 > y0) doc.rect(X(x0), Y(y0), (x1 - x0) * s, (y1 - y0) * s, 'S')
  }
  doc.setDrawColor(70).setFillColor(...WOOD)
  for (const r of rects) doc.rect(X(r.x0), Y(r.y0), (r.x1 - r.x0) * s, (r.y1 - r.y0) * s, 'FD')

  // Overlaps between the chosen sticks: shaded, with dotted lines for the
  // edges of one stick that run across the face of the other.
  doc.setFillColor(205, 180, 140)
  for (const j of jointsOf({ ...design, members: chosen })) {
    doc.rect(X(j.r.x0), Y(j.r.y0), (j.r.x1 - j.r.x0) * s, (j.r.y1 - j.r.y0) * s, 'F')
    for (const e of j.edges) {
      doc.setLineDashPattern(e.hidden ? [0.35, 0.35] : [], 0)
      doc.line(X(e.line[0]), Y(e.line[1]), X(e.line[2]), Y(e.line[3]))
    }
  }
  doc.setLineDashPattern([], 0)

  // Each letter is a badge centred on its own stick, in a stretch where no
  // other stick crosses, so there is no doubt which stick it names.
  const all = design.members.map((m) => ({ id: m.id, r: rectOf(m, design.stocks) }))
  const placed: { x: number; y: number; rad: number }[] = []
  doc.setFont('helvetica', 'bold').setFontSize(6.5).setLineWidth(0.15)
  chosen.forEach((m, i) => {
    const r = rects[i]
    const h = m.dir === 'h'
    const label = letterOf.get(m.id) ?? ''
    const bw = Math.max(3.2, doc.getTextWidth(label) + 1.4)
    const bh = 3.2
    const rad = Math.max(bw, bh) / 2

    // Stretches of this stick that no other stick overlaps, longest first.
    const lo = h ? r.x0 : r.y0
    const hi = h ? r.x1 : r.y1
    const blocks = all
      .filter((o) => o.id !== m.id && o.r.x0 < r.x1 && o.r.x1 > r.x0 && o.r.y0 < r.y1 && o.r.y1 > r.y0)
      .map((o) => (h ? [o.r.x0, o.r.x1] : [o.r.y0, o.r.y1]))
      .sort((a, b) => a[0] - b[0])
    const free: [number, number][] = []
    let at = lo
    for (const [b0, b1] of blocks) {
      if (b0 > at) free.push([at, b0])
      at = Math.max(at, b1)
    }
    if (hi > at) free.push([at, hi])
    if (!free.length) free.push([lo, hi])
    free.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))

    // How badly a badge at (cx, cy) would crowd other sticks and other badges.
    const crowding = (cx: number, cy: number) => {
      let bad = 0
      for (const o of all) {
        if (o.id === m.id) continue
        const dx = Math.max(X(o.r.x0) - cx, 0, cx - X(o.r.x1))
        const dy = Math.max(Y(o.r.y0) - cy, 0, cy - Y(o.r.y1))
        if (Math.hypot(dx, dy) < rad) bad += 1
      }
      for (const q of placed) if (Math.hypot(q.x - cx, q.y - cy) < q.rad + rad + 0.3) bad += 10
      return bad
    }
    let best: { x: number; y: number; bad: number } | null = null
    for (const [f0, f1] of free) {
      for (const k of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const along = f0 + (f1 - f0) * k
        const x = h ? X(along) : X((r.x0 + r.x1) / 2)
        const y = h ? Y((r.y0 + r.y1) / 2) : Y(along)
        const bad = crowding(x, y)
        if (!best || bad < best.bad) best = { x, y, bad }
        if (bad === 0) break
      }
      if (best?.bad === 0) break
    }
    const { x, y } = best!
    placed.push({ x, y, rad })
    // Set every time: drawing text resets the fill colour to the text colour.
    doc.setFillColor(255, 255, 255).setDrawColor(40)
    doc.roundedRect(x - bw / 2, y - bh / 2, bw, bh, 1.6, 1.6, 'FD')
    doc.setTextColor(20)
    doc.text(label, x, y + 0.85, { align: 'center' })
  })
}

/** Paper mm per real mm for a stick's thickness and width, which are drawn larger than its length. */
const CS = 1.1
/**
 * How far one mm of face width shifts the drawing right and up, for the
 * slanted view. Width is drawn at three quarters of the thickness scale, so
 * an 11 mm face still reads as clearly wider than a 5 mm thickness.
 */
const KX = CS * 0.62
const KY = CS * 0.42
const TOP: [number, number, number] = [247, 236, 215]
const SIDE: [number, number, number] = [230, 208, 172]
const SHADE: [number, number, number] = [200, 174, 134]

function drawSticks(doc: jsPDF, types: StickType[]) {
  // Leaves room on the right for the slanted end and its size labels.
  const usable = PAGE_W - 2 * M - 34
  const s = Math.min(1, usable / Math.max(...types.map((t) => t.len)))
  let y = 0

  const newPage = () => {
    doc.addPage()
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(20)
    doc.text('Sticks', M, 16)
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(110)
    doc.text(
      [
        'Each stick is drawn lying on its back with its front face up. A notch in the top is cut into the front (F); a notch underneath is cut into the back, the hanji side (B).',
        `Lengths are drawn at 1:${fmt(1 / s)}; thickness and width are enlarged so the notches show, and are written at the right-hand end. The left end of a horizontal stick, or the top end of a vertical stick, is on the left.`,
        'Under each stick: the upper row is the distance between notches, the lower row is the width of each notch. All measurements in mm.',
      ],
      M,
      21,
    )
    y = 40
  }
  newPage()

  for (const t of types) {
    const depths = [...new Set(t.notches.map((n) => fmt(n.depth)))]
    const list = t.notches.length
      ? 'Notches from that end: ' +
        t.notches
          .map(
            (n) =>
              `${fmt(n.pos)}-${fmt(n.pos + n.width)} mm ${n.side === 'front' ? 'F' : 'B'}` +
              (depths.length > 1 ? ` (${fmt(n.depth)} mm deep)` : ''),
          )
          .join(',  ') +
        (depths.length === 1 ? `.  All ${depths[0]} mm deep.` : '.')
      : 'No notches.'
    doc.setFont('helvetica', 'normal').setFontSize(7)
    const lines: string[] = doc.splitTextToSize(list, PAGE_W - 2 * M)
    const D = t.depth
    const W = t.faceW
    const stickH = D * CS + W * KY
    const height = 4 + stickH + 13 + lines.length * 3.2 + 6
    if (y + height > PAGE_H - M) newPage()

    // Heading
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(20)
    doc.text(t.letter, M, y)
    const lw = doc.getTextWidth(t.letter)
    doc.setFont('helvetica', 'normal').setFontSize(9)
    doc.text(
      `${t.members.length} ×   length ${fmt(t.len)} mm   ·   ${t.stock} mm stock: front face ${fmt(t.faceW)} mm wide, ${fmt(t.depth)} mm thick`,
      M + lw + 3,
      y,
    )

    // The stick. x runs along its length, w across its face, z up from its back.
    const base = y + 4 + stickH
    const P = (x: number, w: number, z: number): [number, number] => [
      M + x * s + w * KX,
      base - z * CS - w * KY,
    ]
    const poly = (fill: [number, number, number], pts: [number, number][]) => {
      doc.setFillColor(...fill)
      doc.lines(
        pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]),
        pts[0][0],
        pts[0][1],
        [1, 1],
        'FD',
        true,
      )
    }
    doc.setLineWidth(0.12).setDrawColor(70).setLineDashPattern([], 0)
    const front = t.notches.filter((n) => n.side === 'front')
    const back = t.notches.filter((n) => n.side === 'back')
    const L = t.len

    // Drawn back to front. First the insides of the notches: the wall facing
    // right, and the floor of each notch cut from the top.
    for (const n of back) {
      if (n.pos > 0) poly(SHADE, [P(n.pos, 0, 0), P(n.pos, W, 0), P(n.pos, W, n.depth), P(n.pos, 0, n.depth)])
    }
    for (const n of front) {
      const z = D - n.depth
      poly(SIDE, [P(n.pos, 0, z), P(n.pos + n.width, 0, z), P(n.pos + n.width, W, z), P(n.pos, W, z)])
      if (n.pos > 0) poly(SHADE, [P(n.pos, 0, z), P(n.pos, W, z), P(n.pos, W, D), P(n.pos, 0, D)])
    }
    // The front face, between the notches cut into it
    let from = 0
    for (const n of [...front, { pos: L, width: 0 }]) {
      if (n.pos > from) poly(TOP, [P(from, 0, D), P(n.pos, 0, D), P(n.pos, W, D), P(from, W, D)])
      from = Math.max(from, n.pos + n.width)
    }
    // The right-hand end, shortened by any notch that runs out to it
    const endLo = back.find((n) => n.pos + n.width >= L - 0.01)?.depth ?? 0
    const endHi = D - (front.find((n) => n.pos + n.width >= L - 0.01)?.depth ?? 0)
    poly(SHADE, [P(L, 0, endLo), P(L, W, endLo), P(L, W, endHi), P(L, 0, endHi)])
    // The near side: its top edge dips at front notches, its bottom edge rises at back notches
    const outline: [number, number][] = [P(0, 0, front[0]?.pos === 0 ? D - front[0].depth : D)]
    for (const n of front) {
      const z = D - n.depth
      if (n.pos > 0) outline.push(P(n.pos, 0, D), P(n.pos, 0, z))
      outline.push(P(n.pos + n.width, 0, z))
      if (n.pos + n.width < L - 0.01) outline.push(P(n.pos + n.width, 0, D))
    }
    if (endHi === D) outline.push(P(L, 0, D))
    if (endLo === 0) outline.push(P(L, 0, 0))
    for (const n of [...back].reverse()) {
      if (n.pos + n.width < L - 0.01) outline.push(P(n.pos + n.width, 0, 0))
      outline.push(P(n.pos + n.width, 0, n.depth), P(n.pos, 0, n.depth))
      if (n.pos > 0) outline.push(P(n.pos, 0, 0))
    }
    if (!(back[0]?.pos === 0)) outline.push(P(0, 0, 0))
    poly(SIDE, outline)

    // Sizes of the cross-section, written beside the right-hand end
    const corner = P(L, W, D)
    doc.setFont('helvetica', 'bold').setFontSize(6).setTextColor(20)
    doc.text(`front face, ${fmt(W)} mm wide`, corner[0] + 1.5, corner[1] + 0.9)
    doc.text(`${fmt(D)} mm thick`, corner[0] + 1.5, P(L, W, 0)[1])
    doc.setFont('helvetica', 'normal')

    // Dimension chain: gaps on the upper row, notch widths on the lower row
    const cuts = [0, ...t.notches.flatMap((n) => [n.pos, n.pos + n.width]), t.len]
    const dy = base + 2.5
    doc.setDrawColor(120).setLineWidth(0.1)
    doc.line(M, dy, M + t.len * s, dy)
    for (const c of cuts) doc.line(M + c * s, dy - 1, M + c * s, dy + 1)
    let gapEnd = -Infinity
    let notchEnd = -Infinity
    for (let i = 0; i + 1 < cuts.length; i++) {
      const size = cuts[i + 1] - cuts[i]
      if (size < 0.05) continue
      const isNotch = i % 2 === 1
      const text =
        `${fmt(size)} mm` + (isNotch ? (t.notches[(i - 1) / 2].side === 'front' ? ' F' : ' B') : '')
      doc.setFontSize(isNotch ? 5.5 : 6.5).setTextColor(isNotch ? 110 : 20)
      const tw = doc.getTextWidth(text)
      const cx = M + ((cuts[i] + cuts[i + 1]) / 2) * s
      // A label that would run into its neighbour is left to the written list below.
      if (isNotch ? cx - tw / 2 < notchEnd + 0.8 : cx - tw / 2 < gapEnd + 0.8 || tw > size * s + 3) continue
      if (isNotch) notchEnd = cx + tw / 2
      else gapEnd = cx + tw / 2
      doc.text(text, cx, dy + (isNotch ? 6 : 3.4), { align: 'center' })
    }

    doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(70)
    doc.text(lines, M, dy + 10)
    y += height
  }
}

/** Build the cut sheet for the selected sticks, or for all of them if none are selected. */
export async function buildPdf(design: Design, selection: Set<string>): Promise<jsPDF | null> {
  const chosen = selection.size
    ? design.members.filter((m) => selection.has(m.id))
    : design.members
  if (!chosen.length) return null
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const types = stickTypes(design, chosen)

  doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(20)
  doc.text('Changho cut sheet', M, 16)
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(70)
  doc.text(
    `${chosen.length} sticks, ${types.length} different.   All measurements in mm.   ${new Date().toLocaleDateString()}`,
    M,
    22,
  )
  drawAssembly(doc, design, chosen, types)
  drawSticks(doc, types)
  return doc
}

export async function exportPdf(design: Design, selection: Set<string>) {
  const doc = await buildPdf(design, selection)
  doc?.save('changho-cut-sheet.pdf')
}
