import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildPdf, letterFor, stickTypes } from './exportPdf'
import type { Design, Member } from './model'

/** A small lattice: an 11 mm frame with 5 mm slats half-lapped into it. */
function lattice(): Design {
  const members: Member[] = []
  const add = (dir: 'h' | 'v', stockId: string, x: number, y: number, len: number) =>
    members.push({ id: `m${members.length}`, stockId, face: 'a', dir, x, y, len })
  add('h', 's11', 0, 0, 400)
  add('h', 's11', 0, 589, 400)
  add('v', 's11', 0, 0, 600)
  add('v', 's11', 389, 0, 600)
  for (const y of [100, 200, 300, 400, 500]) add('h', 's5', 0, y, 400)
  for (const x of [80, 160, 240, 320]) add('v', 's5', x, 0, 600)
  add('v', 's5', 200, 200, 205) // a short stile between two rails
  return {
    panel: { w: 400, h: 600 },
    stocks: [
      { id: 's5', a: 5, b: 5 },
      { id: 's11', a: 11, b: 5 },
    ],
    members,
  }
}

describe('pdf export', () => {
  it('letters sticks past Z', () => {
    expect([0, 25, 26, 27, 52].map(letterFor)).toEqual(['A', 'Z', 'AA', 'AB', 'BA'])
  })

  it('gives identical sticks one letter and keeps joints with unselected pieces', () => {
    const d = lattice()
    const all = stickTypes(d, d.members)
    expect(all.map((t) => [t.letter, t.members.length])).toEqual([
      ['A', 2], // top and bottom rails
      ['B', 2], // slats that the short stile does not touch
      ['C', 3], // slats the short stile laps into
      ['D', 2], // side stiles
      ['E', 4], // full-height slats
      ['F', 1], // short stile
    ])
    const one = stickTypes(d, [d.members[4]])
    expect(one[0].notches.length).toBe(6)
  })

  it('builds a pdf', async () => {
    const d = lattice()
    const doc = await buildPdf(d, new Set())
    expect(doc!.getNumberOfPages()).toBeGreaterThanOrEqual(2)
    if (process.env.PDF_OUT) writeFileSync(process.env.PDF_OUT, Buffer.from(doc!.output('arraybuffer')))
    // An 11x5 rail on edge (11 deep) crossing the 5 deep slats: it takes back notches.
    d.members.push({ id: 'edge', stockId: 's11', face: 'b', dir: 'h', x: 0, y: 550, len: 400 })
    const part = await buildPdf(d, new Set(['m4', 'm5', 'm9', 'm13', 'edge']))
    if (process.env.PDF_OUT) {
      writeFileSync(process.env.PDF_OUT.replace('.pdf', '-part.pdf'), Buffer.from(part!.output('arraybuffer')))
    }
  })
})
