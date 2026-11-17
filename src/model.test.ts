import { describe, expect, it } from 'vitest'
import {
  assemblySteps,
  cutList,
  defaultDimPos,
  dimGeom,
  distribute,
  notchesOf,
  parallelOverlaps,
  rectOf,
  snapEnd,
  type Design,
} from './model'

const base: Design = {
  panel: { w: 600, h: 900 },
  stocks: [
    { id: 's5', a: 5, b: 5 },
    { id: 's11', a: 11, b: 5 },
  ],
  members: [],
}

describe('half-laps', () => {
  it('cuts matching notches at a T joint', () => {
    const d: Design = {
      ...base,
      members: [
        { id: 'stile', stockId: 's11', face: 'a', dir: 'v', x: 0, y: 0, len: 100 },
        { id: 'rail', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 40, len: 60 },
      ],
    }
    const n = notchesOf(d)
    expect(n.get('rail')).toEqual([{ pos: 0, width: 11, depth: 2.5, side: 'front' }])
    expect(n.get('stile')).toEqual([{ pos: 40, width: 5, depth: 2.5, side: 'back' }])
  })

  it('gives the front notch to a vertical that is shallower than the horizontal', () => {
    const d: Design = {
      ...base,
      members: [
        // 11x5 on edge: 5 face, 11 deep
        { id: 'deep', stockId: 's11', face: 'b', dir: 'h', x: 0, y: 40, len: 60 },
        { id: 'thin', stockId: 's5', face: 'a', dir: 'v', x: 20, y: 0, len: 100 },
      ],
    }
    const n = notchesOf(d)
    expect(n.get('deep')).toEqual([{ pos: 20, width: 5, depth: 2.5, side: 'back' }])
    expect(n.get('thin')).toEqual([{ pos: 40, width: 5, depth: 2.5, side: 'front' }])
  })

  it('keeps equal notches when the vertical is the deeper one', () => {
    const d: Design = {
      ...base,
      members: [
        // 11x5 on edge: 5 face, 11 deep
        { id: 'deep', stockId: 's11', face: 'b', dir: 'v', x: 20, y: 0, len: 100 },
        { id: 'thin', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 40, len: 60 },
      ],
    }
    const n = notchesOf(d)
    expect(n.get('thin')).toEqual([{ pos: 20, width: 5, depth: 2.5, side: 'front' }])
    expect(n.get('deep')).toEqual([{ pos: 40, width: 5, depth: 2.5, side: 'back' }])
  })

  it('groups identical members in the cut list', () => {
    const d: Design = {
      ...base,
      members: [
        { id: 'a', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 10, len: 60 },
        { id: 'b', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 50, len: 60 },
        { id: 'c', stockId: 's5', face: 'a', dir: 'v', x: 30, y: 0, len: 80 },
      ],
    }
    const rows = cutList(d)
    expect(rows.map((r) => [r.qty, r.len, r.notches.length])).toEqual([
      [1, 80, 2],
      [2, 60, 1],
    ])
  })
})

describe('assembly order', () => {
  it('never needs weaving: the front-notched stick always goes down first', () => {
    // every mix of thin and thick, horizontal and vertical, all crossing each other
    const d: Design = {
      ...base,
      members: [
        { id: 'h5', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 20, len: 200 },
        { id: 'h11', stockId: 's11', face: 'b', dir: 'h', x: 0, y: 60, len: 200 },
        { id: 'h5b', stockId: 's11', face: 'a', dir: 'h', x: 0, y: 100, len: 200 },
        { id: 'v5', stockId: 's5', face: 'a', dir: 'v', x: 40, y: 0, len: 200 },
        { id: 'v11', stockId: 's11', face: 'b', dir: 'v', x: 90, y: 0, len: 200 },
        { id: 'v5b', stockId: 's11', face: 'a', dir: 'v', x: 140, y: 0, len: 200 },
      ],
    }
    const steps = assemblySteps(d, d.members)
    expect(steps.map((s) => `${s.dir}${s.depth}`)).toEqual(['h5', 'v5', 'h11', 'v11'])
    const stepOf = new Map<string, number>()
    steps.forEach((s, i) => s.members.forEach((m) => stepOf.set(m.id, i)))
    const notches = notchesOf(d)
    const hs = d.members.filter((m) => m.dir === 'h')
    const vs = d.members.filter((m) => m.dir === 'v')
    for (const h of hs) {
      for (const v of vs) {
        // all nine pairs cross; the stick notched on the front is the one underneath
        const hUnder = notches.get(h.id)!.find((n) => n.pos === v.x)!.side === 'front'
        const [under, over] = hUnder ? [h, v] : [v, h]
        expect(stepOf.get(under.id)!).toBeLessThan(stepOf.get(over.id)!)
      }
    }
  })
})

describe('snapping', () => {
  const stile = rectOf(
    { id: 'stile', stockId: 's11', face: 'a', dir: 'v', x: 100, y: 0, len: 100 },
    base.stocks,
  )

  it('pulls an end to the far edge of a crossing member', () => {
    // right end approaching from the left, and left end from the right
    expect(snapEnd(98, true, 'h', [40, 45], [stile], [], 4).value).toBe(111)
    expect(snapEnd(113, false, 'h', [40, 45], [stile], [], 4).value).toBe(100)
  })

  it('ignores members it does not cross', () => {
    expect(snapEnd(98.4, true, 'h', [200, 205], [stile], [], 4).value).toBe(98)
  })
})

describe('distance markers', () => {
  const d: Design = {
    ...base,
    members: [
      { id: 'a', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 10, len: 60 },
      { id: 'b', stockId: 's5', face: 'a', dir: 'h', x: 20, y: 50, len: 60 },
      { id: 'c', stockId: 's5', face: 'a', dir: 'v', x: 30, y: 0, len: 80 },
    ],
  }

  it('measures the gap between facing edges, whichever order they are picked in', () => {
    expect(defaultDimPos(d, 'b', 'a')).toBe(40)
    const g = dimGeom(d, { id: 'm', a: 'b', b: 'a', pos: 40 })!
    expect([g.dir, g.from, g.to, g.dist, g.ext.length]).toEqual(['h', 15, 50, 35, 0])
  })

  it('adds extension lines when the marker is dragged past the ends', () => {
    const g = dimGeom(d, { id: 'm', a: 'a', b: 'b', pos: 100 })!
    expect(g.ext).toEqual([
      { at: 15, from: 60, to: 100 },
      { at: 50, from: 80, to: 100 },
    ])
  })

  it('is hidden for members that are not parallel', () => {
    expect(dimGeom(d, { id: 'm', a: 'a', b: 'c', pos: 0 })).toBeNull()
  })
})

describe('layout helpers', () => {
  it('flags parallel overlaps', () => {
    const d: Design = {
      ...base,
      members: [
        { id: 'a', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 10, len: 60 },
        { id: 'b', stockId: 's5', face: 'a', dir: 'h', x: 30, y: 12, len: 60 },
      ],
    }
    expect([...parallelOverlaps(d)].sort()).toEqual(['a', 'b'])
  })

  it('distributes with equal gaps', () => {
    const d: Design = {
      ...base,
      members: [
        { id: 'a', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 0, len: 60 },
        { id: 'b', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 13, len: 60 },
        { id: 'c', stockId: 's5', face: 'a', dir: 'h', x: 0, y: 95, len: 60 },
      ],
    }
    const out = distribute(d, new Set(['a', 'b', 'c']))
    expect(out.map((m) => m.y)).toEqual([0, 47.5, 95])
  })
})
