import { fromSoup, type Mesh } from './mesh'

/** Axis-aligned box from (0,0,0) to (w,d,h), 12 triangles, normals outwards. */
export function makeBox(w: number, d: number, h: number): Mesh {
  const v = [0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h]
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { positions: Float32Array.from(v), indices: Uint32Array.from(f) }
}

/** UV sphere with poles on the Z axis. */
export function makeSphere(radius: number, segments = 32, rings = 16): Mesh {
  const pos: number[] = []
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * Math.PI
    for (let j = 0; j < segments; j++) {
      if ((i === 0 || i === rings) && j > 0) continue
      const ph = (j / segments) * 2 * Math.PI
      pos.push(radius * Math.sin(th) * Math.cos(ph), radius * Math.sin(th) * Math.sin(ph), radius * Math.cos(th))
    }
  }
  const vid = (i: number, j: number) => (i === 0 ? 0 : i === rings ? 1 + (rings - 1) * segments : 1 + (i - 1) * segments + (j % segments))
  const idx: number[] = []
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) {
      const a = vid(i, j), b = vid(i + 1, j), c = vid(i + 1, j + 1), d = vid(i, j + 1)
      if (i > 0) idx.push(a, b, d)
      if (i < rings - 1) idx.push(d, b, c)
    }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** Torus around the Z axis. Volume is 2 pi^2 R r^2 in the limit of fine tessellation. */
export function makeTorus(major: number, minor: number, nu = 40, nv = 20): Mesh {
  const pos: number[] = []
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const u = (i / nu) * 2 * Math.PI, w = (j / nv) * 2 * Math.PI
      pos.push((major + minor * Math.cos(w)) * Math.cos(u), (major + minor * Math.cos(w)) * Math.sin(u), minor * Math.sin(w))
    }
  const vid = (i: number, j: number) => (i % nu) * nv + (j % nv)
  const idx: number[] = []
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a = vid(i, j), b = vid(i + 1, j), c = vid(i + 1, j + 1), d = vid(i, j + 1)
      idx.push(a, b, c, a, c, d)
    }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** Unwelded triangle soup, like a typical STL file. */
export function toSoup(m: Mesh, edit?: (t: number, tri: number[]) => number[] | null): Float32Array {
  const out: number[] = []
  for (let t = 0; t < m.indices.length / 3; t++) {
    let tri = [0, 1, 2].map((k) => m.indices[t * 3 + k])
    const pts: number[][] = tri.map((v) => [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]])
    if (edit) {
      const r = edit(t, tri)
      if (!r) continue
      tri = r
    }
    // `tri` may be reordered by the editor: map back through the original indices
    for (const v of tri) {
      const k = [m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]].indexOf(v)
      out.push(...(k >= 0 ? pts[k] : [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]]))
    }
  }
  return Float32Array.from(out)
}

export type SampleId = 'torus' | 'damaged' | 'finned'

/** A sphere with a hole, two missing triangles, a few flipped ones, a seam of near-duplicate vertices and a sliver. */
function damagedSphere(): Mesh {
  const base = makeSphere(20, 36, 18)
  const soup = Array.from(
    toSoup(base, (t, tri) => {
      if (t >= 300 && t < 308) return null // a hole
      if (t === 120 || t === 515) return null // single missing triangles
      if ([40, 41, 700, 900, 901].includes(t)) return [tri[0], tri[2], tri[1]] // flipped normals
      return tri
    }),
  )
  // nudge a band of vertices so the exact-match weld in the loader cannot join them (needs the tolerance weld)
  for (let t = 0; t < soup.length / 9; t++) {
    const x = soup[t * 9], y = soup[t * 9 + 1]
    if (Math.abs(y) < 3 && x > 0) for (let k = 0; k < 9; k += 3) soup[t * 9 + k] += 2e-5
  }
  soup.push(0, 0, 0, 1, 0, 0, 2, 0, 0) // zero-area sliver
  return fromSoup(soup)
}

/** An inside-out cube with a loose fin that shares one edge with three faces. */
function finnedCube(): Mesh {
  const box = makeBox(20, 20, 20)
  const soup = Array.from(toSoup(box, (_t, tri) => [tri[0], tri[2], tri[1]]))
  soup.push(20, 0, 20, 20, 20, 20, 40, 10, 40)
  return fromSoup(soup)
}

export function makeSample(id: SampleId): Mesh {
  switch (id) {
    case 'torus':
      return makeTorus(18, 6, 48, 24)
    case 'damaged':
      return damagedSphere()
    case 'finned':
      return finnedCube()
  }
}
