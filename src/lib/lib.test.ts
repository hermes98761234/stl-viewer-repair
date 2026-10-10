import Module, { type ManifoldToplevel } from 'manifold-3d'
import { beforeAll, describe, expect, it } from 'vitest'
import { detectFormat, parse3MF, parseModel, parseOBJ, parseSTL, write3MF, writeSTL } from './io'
import { applyLinear, bbox, flipTriangles, mirrorMesh, placeOnBed, rotateMesh, scaleMesh, signedVolume, surfaceArea, triCount, type Mesh } from './mesh'
import { dropNonManifold, fillHoles, libCheck, makeManifold, orientMesh, removeDegenerate, removeDuplicates, repairAll, triangulatePolygon } from './repair'
import { makeBox, makeSample, makeSphere, makeTorus } from './shapes'
import { sliceMesh } from './slice'
import { analyze } from './topology'
import { weldVertices } from './weld'

let wasm: ManifoldToplevel
beforeAll(async () => {
  wasm = await Module()
  wasm.setup()
})

const dropTris = (m: Mesh, drop: number[]): Mesh => {
  const out: number[] = []
  for (let t = 0; t < triCount(m); t++) if (!drop.includes(t)) out.push(m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2])
  return { positions: m.positions, indices: Uint32Array.from(out) }
}

describe('measurements', () => {
  it('box volume, area and bounding box', () => {
    const b = makeBox(10, 20, 30)
    expect(signedVolume(b)).toBeCloseTo(6000, 3)
    expect(surfaceArea(b)).toBeCloseTo(2 * (200 + 300 + 600), 3)
    expect(bbox(b)).toEqual({ min: [0, 0, 0], max: [10, 20, 30] })
  })
  it('sphere volume approaches 4/3 pi r^3', () => {
    const s = makeSphere(10, 128, 64)
    expect(signedVolume(s)).toBeGreaterThan(0)
    expect(signedVolume(s)).toBeCloseTo((4 / 3) * Math.PI * 1000, -1) // within ~5 of 4188.8
    expect(Math.abs(signedVolume(s) / ((4 / 3) * Math.PI * 1000) - 1)).toBeLessThan(0.002)
    expect(Math.abs(surfaceArea(s) / (4 * Math.PI * 100) - 1)).toBeLessThan(0.002)
  })
  it('torus volume is 2 pi^2 R r^2', () => {
    const t = makeTorus(20, 5, 96, 48)
    expect(Math.abs(signedVolume(t) / (2 * Math.PI ** 2 * 20 * 25) - 1)).toBeLessThan(0.005)
  })
})

describe('transforms', () => {
  it('scales volume by the cube of the factor and mirrors keep normals outward', () => {
    const b = makeBox(1, 2, 3)
    expect(signedVolume(scaleMesh(b, 2))).toBeCloseTo(48, 4)
    expect(signedVolume(mirrorMesh(b, 0))).toBeCloseTo(6, 4)
    expect(signedVolume(scaleMesh(b, 25.4)) / (6 * 25.4 ** 3)).toBeCloseTo(1, 5)
  })
  it('rotation by 90 degrees swaps the extents', () => {
    const r = rotateMesh(makeBox(1, 2, 3), 0, 90)
    const { min, max } = bbox(r)
    expect(max[1] - min[1]).toBeCloseTo(3, 5)
    expect(max[2] - min[2]).toBeCloseTo(2, 5)
  })
  it('places on the bed', () => {
    const r = placeOnBed(applyLinear(makeBox(2, 2, 2), [1, 0, 0, 0, 1, 0, 0, 0, 1], [5, 5, -7]))
    expect(bbox(r)).toEqual({ min: [-1, -1, 0], max: [1, 1, 2] })
  })
})

describe('analysis', () => {
  it('accepts a closed box', () => {
    const a = analyze(makeBox(10, 10, 10))
    expect(a.watertight).toBe(true)
    expect(a).toMatchObject({ boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, holes: 0, shells: 1, edges: 18 })
  })
  it('finds a square hole where two triangles are missing', () => {
    const a = analyze(dropTris(makeBox(10, 10, 10), [0, 1]))
    expect(a.boundaryEdges).toBe(4)
    expect(a.holes).toBe(1)
    expect(a.watertight).toBe(false)
  })
  it('finds flipped triangles by their three inconsistent edges', () => {
    const a = analyze(flipTriangles(makeBox(1, 1, 1), new Set([0])))
    expect(a.inconsistentEdges).toBe(3)
  })
  it('finds an edge shared by three triangles', () => {
    const b = makeBox(1, 1, 1)
    const p = new Float32Array([...b.positions, 5, 5, 5])
    const idx = new Uint32Array([...b.indices, 0, 1, 8]) // fin on the 0-1 edge
    const a = analyze({ positions: p, indices: idx })
    expect(a.nonManifoldEdges).toBe(1)
  })
  it('detects an inside-out solid', () => {
    const a = analyze(flipTriangles(makeBox(2, 2, 2)))
    expect(a.volume).toBeCloseTo(-8, 5)
    expect(a.invertedShells).toBe(1)
    expect(a.inconsistentEdges).toBe(0)
  })
  it('counts shells, degenerate and duplicate triangles', () => {
    const b = makeBox(1, 1, 1)
    const n = b.positions.length / 3
    const pos = new Float32Array([...b.positions, ...b.positions.map((x) => x + 10)])
    const idx = new Uint32Array([...b.indices, ...b.indices.map((i) => i + n), 0, 0, 1, 0, 1, 2])
    const a = analyze({ positions: pos, indices: idx })
    expect(a.shells).toBe(2)
    expect(a.degenerate).toBe(1)
    expect(a.duplicate).toBe(1)
  })
})

describe('repair steps', () => {
  it('welds vertices within the tolerance', () => {
    const s = makeSample('damaged')
    const before = analyze(s)
    expect(before.mergeable).toBeGreaterThan(0)
    const w = weldVertices(s, 1e-3)
    expect(w.merged).toBe(before.mergeable)
    expect(weldVertices(makeBox(1, 1, 1), 0).merged).toBe(0)
  })
  it('re-orients an inside-out box and repairs flipped faces', () => {
    const bad = flipTriangles(flipTriangles(makeBox(10, 10, 10)), new Set([3, 7]))
    const r = orientMesh(bad)
    expect(signedVolume(r.mesh)).toBeCloseTo(1000, 3)
    expect(analyze(r.mesh).watertight).toBe(true)
  })
  it('fills a missing box face exactly', () => {
    const open = dropTris(makeBox(10, 10, 10), [0, 1])
    const f = fillHoles(open)
    expect(f.filled).toBe(1)
    expect(f.added).toBe(2)
    expect(signedVolume(f.mesh)).toBeCloseTo(1000, 3)
    expect(analyze(f.mesh).watertight).toBe(true)
  })
  it('ear clips a concave polygon with the right area', () => {
    // L shape, area 3, counter-clockwise seen from +Z
    const p = new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0])
    const tris = triangulatePolygon(p, [0, 1, 2, 3, 4, 5])
    expect(tris.length / 3).toBe(4)
    expect(signedVolume({ positions: p, indices: Uint32Array.from(tris) })).toBe(0)
    let area = 0
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]]
      area += ((p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[c * 3] - p[a * 3]) * (p[b * 3 + 1] - p[a * 3 + 1])) / 2
    }
    expect(area).toBeCloseTo(3, 6)
  })
  it('removes degenerate and duplicate triangles', () => {
    const b = makeBox(1, 1, 1)
    const m: Mesh = { positions: b.positions, indices: new Uint32Array([...b.indices, 0, 0, 1, ...b.indices.slice(0, 3)]) }
    expect(removeDegenerate(m).removed).toBe(1)
    expect(removeDuplicates(m).removed).toBe(1)
  })
  it('drops the extra triangles of a non-manifold edge', () => {
    const b = makeBox(1, 1, 1)
    const m: Mesh = { positions: new Float32Array([...b.positions, 5, 5, 5]), indices: new Uint32Array([...b.indices, 0, 1, 8]) }
    const r = dropNonManifold(m)
    expect(r.removed).toBe(1)
    expect(analyze(r.mesh).nonManifoldEdges).toBe(0)
  })
})

describe('Manifold library', () => {
  it('accepts a box and measures it', () => {
    const c = libCheck(makeBox(10, 10, 10), wasm)
    expect(c.valid).toBe(true)
    expect(c.volume).toBeCloseTo(1000, 2)
    expect(c.area).toBeCloseTo(600, 2)
    expect(c.genus).toBe(0)
  })
  it('reports torus genus 1', () => {
    expect(libCheck(makeSample('torus'), wasm).genus).toBe(1)
  })
  it('rejects an open mesh', () => {
    expect(libCheck(dropTris(makeBox(1, 1, 1), [0]), wasm).valid).toBe(false)
  })
  it('makeManifold turns a holey mesh into a valid solid', () => {
    const r = makeManifold(dropTris(makeBox(10, 10, 10), [0, 1, 5]), wasm)
    expect(r.ok).toBe(true)
    expect(libCheck(r.mesh, wasm).valid).toBe(true)
    expect(signedVolume(r.mesh)).toBeCloseTo(1000, 2)
  })
})

describe('repair pipeline', () => {
  it('repairs the damaged sphere sample', () => {
    const s = makeSample('damaged')
    const a0 = analyze(s)
    expect(a0.boundaryEdges).toBeGreaterThan(0)
    expect(a0.inconsistentEdges).toBeGreaterThan(0)
    const r = repairAll(s, wasm, { tolerance: 1e-3, maxHoleEdges: 5000, manifold: true })
    expect(r.ok).toBe(true)
    const a1 = analyze(r.mesh)
    expect(a1.watertight).toBe(true)
    expect(a1.invertedShells).toBe(0)
    expect(libCheck(r.mesh, wasm).valid).toBe(true)
    const ideal = (4 / 3) * Math.PI * 8000
    expect(Math.abs(a1.volume / ideal - 1)).toBeLessThan(0.03)
  })
  it('repairs the finned inside-out cube', () => {
    const s = makeSample('finned')
    expect(analyze(s).nonManifoldEdges).toBeGreaterThan(0)
    const r = repairAll(s, wasm, { tolerance: 1e-3, maxHoleEdges: 5000, manifold: true })
    expect(r.ok).toBe(true)
    expect(signedVolume(r.mesh)).toBeCloseTo(8000, 1)
  })
  it('leaves a healthy mesh alone', () => {
    const t = makeSample('torus')
    const r = repairAll(t, wasm, { tolerance: 1e-3, maxHoleEdges: 5000, manifold: true })
    expect(triCount(r.mesh)).toBe(triCount(t))
    expect(signedVolume(r.mesh)).toBeCloseTo(signedVolume(t), 2)
  })
})

describe('cross-section', () => {
  it('cuts a box into a rectangle', () => {
    const s = sliceMesh(makeBox(10, 20, 30), 2, 15)
    expect(s.loops.length).toBe(1)
    expect(s.area).toBeCloseTo(200, 3)
    expect(s.perimeter).toBeCloseTo(60, 3)
  })
  it('cuts through a vertex plane without breaking the loop', () => {
    const s = sliceMesh(makeBox(10, 10, 10), 2, 10 - 1e-12)
    expect(s.loops.length).toBeGreaterThan(0)
  })
  it('cuts a sphere at its equator', () => {
    const s = sliceMesh(makeSphere(10, 128, 64), 2, 0)
    expect(Math.abs(s.area / (Math.PI * 100) - 1)).toBeLessThan(0.002)
  })
  it('cuts a torus into two rings with the right net area', () => {
    const s = sliceMesh(makeTorus(20, 5, 96, 48), 0, 0)
    expect(s.loops.length).toBe(2)
    expect(Math.abs(s.area / (2 * Math.PI * 25) - 1)).toBeLessThan(0.01)
  })
  it('cuts a hollow shell: inner loop subtracts', () => {
    const outer = makeBox(10, 10, 10)
    const inner = flipTriangles(applyLinear(makeBox(4, 4, 4), [1, 0, 0, 0, 1, 0, 0, 0, 1], [3, 3, 3]))
    const n = outer.positions.length / 3
    const hollow: Mesh = { positions: new Float32Array([...outer.positions, ...inner.positions]), indices: new Uint32Array([...outer.indices, ...inner.indices.map((i) => i + n)]) }
    expect(sliceMesh(hollow, 2, 5).area).toBeCloseTo(100 - 16, 3)
  })
})

describe('file formats', () => {
  const box = makeBox(1, 2, 3)
  it('round-trips binary STL', () => {
    const buf = writeSTL(box)
    expect(buf.byteLength).toBe(84 + 12 * 50)
    const m = parseSTL(buf)
    expect(triCount(m)).toBe(12)
    expect(m.positions.length / 3).toBe(8)
    expect(signedVolume(m)).toBeCloseTo(6, 5)
  })
  it('parses ASCII STL', () => {
    const txt = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n'
    const m = parseSTL(new TextEncoder().encode(txt).buffer as ArrayBuffer)
    expect(triCount(m)).toBe(1)
    expect(Array.from(m.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
  })
  it('parses binary STL even when the header starts with "solid"', () => {
    const buf = writeSTL(box, 'solid exported by something')
    expect(triCount(parseSTL(buf))).toBe(12)
  })
  it('parses OBJ with quads, slashes and negative indices', () => {
    const m = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3 4/4/4\nf -4 -3 -2\n')
    expect(triCount(m)).toBe(3)
    expect(Array.from(m.indices.slice(6))).toEqual([0, 1, 2])
  })
  it('round-trips 3MF with units', () => {
    const z = write3MF(box)
    const m = parse3MF(z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer)
    expect(triCount(m)).toBe(12)
    expect(signedVolume(m)).toBeCloseTo(6, 5)
    expect(detectFormat('x.bin', z.buffer as ArrayBuffer)).toBe('3mf')
  })
  it('rejects empty files', () => {
    expect(() => parseModel('a.stl', writeSTL({ positions: new Float32Array(0), indices: new Uint32Array(0) }))).toThrow()
  })
})
