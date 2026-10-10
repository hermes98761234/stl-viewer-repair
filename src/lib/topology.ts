import { bbox, signedVolume, surfaceArea, triArea, type Mesh, type Vec3 } from './mesh'
import { weldVertices } from './weld'

export interface Analysis {
  vertices: number
  triangles: number
  /** Vertices not used by any triangle. */
  unreferenced: number
  /** Zero-area or collapsed triangles. */
  degenerate: number
  /** Triangles repeating another one's three vertices. */
  duplicate: number
  /** Vertices that sit within the tolerance of another vertex and could be merged. */
  mergeable: number
  edges: number
  /** Edges used by one triangle only. */
  boundaryEdges: number
  /** Edges used by more than two triangles. */
  nonManifoldEdges: number
  /** Edges whose two triangles disagree about direction (flipped normals). */
  inconsistentEdges: number
  /** Closed loops of boundary edges. */
  holes: number
  shells: number
  /** Shells whose normals point inwards. */
  invertedShells: number
  volume: number
  area: number
  min: Vec3
  max: Vec3
  /** True when every edge joins exactly two consistently oriented triangles. */
  watertight: boolean
  /** Line segment endpoints (x,y,z,x,y,z,...) for the 3D issue overlay. */
  boundaryLines: Float32Array
  nonManifoldLines: Float32Array
  inconsistentLines: Float32Array
}

/** Packs an undirected edge into one number (exact while vertexCount < 94 million). */
export const edgeKey = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a)

export function isDegenerate(m: Mesh, t: number, eps: number): boolean {
  const a = m.indices[t * 3], b = m.indices[t * 3 + 1], c = m.indices[t * 3 + 2]
  if (a === b || b === c || a === c) return true
  return triArea(m.positions, a, b, c) <= eps
}

class DSU {
  parent: Int32Array
  constructor(n: number) {
    this.parent = new Int32Array(n)
    for (let i = 0; i < n; i++) this.parent[i] = i
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  union(a: number, b: number) {
    a = this.find(a)
    b = this.find(b)
    if (a !== b) this.parent[a] = b
  }
}

/** Loops of directed boundary edges (a to b where the edge has no partner). */
export function boundaryLoops(m: Mesh): number[][] {
  const n = m.positions.length / 3
  const stat = new Map<number, number>() // key -> count of triangles using the edge
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(m.indices[t + k], m.indices[t + (k + 1) % 3], n)
      stat.set(key, (stat.get(key) ?? 0) + 1)
    }
  }
  const next = new Map<number, number[]>()
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = m.indices[t + k], b = m.indices[t + (k + 1) % 3]
      if (a === b || stat.get(edgeKey(a, b, n)) !== 1) continue
      const l = next.get(a)
      if (l) l.push(b)
      else next.set(a, [b])
    }
  }
  const loops: number[][] = []
  for (const [start] of next) {
    while (next.get(start)?.length) {
      const loop = [start]
      let cur = start
      for (;;) {
        const l = next.get(cur)
        if (!l || l.length === 0) break
        const nx = l.pop()!
        if (nx === start) break
        loop.push(nx)
        cur = nx
      }
      loops.push(loop)
    }
  }
  return loops
}

export function analyze(m: Mesh, tolerance = 1e-5): Analysis {
  const n = m.positions.length / 3
  const nt = m.indices.length / 3
  const p = m.positions
  const cnt = new Map<number, number>()
  const fwd = new Map<number, number>()
  const used = new Uint8Array(n)
  let degenerate = 0
  const seen = new Set<string>()
  let duplicate = 0
  const dsu = new DSU(n)
  for (let t = 0; t < nt; t++) {
    const a = m.indices[t * 3], b = m.indices[t * 3 + 1], c = m.indices[t * 3 + 2]
    used[a] = used[b] = used[c] = 1
    dsu.union(a, b)
    dsu.union(b, c)
    if (isDegenerate(m, t, 0)) degenerate++
    const sorted = [a, b, c].sort((x, y) => x - y)
    const sk = `${sorted[0]},${sorted[1]},${sorted[2]}`
    if (seen.has(sk)) duplicate++
    else seen.add(sk)
    for (let k = 0; k < 3; k++) {
      const u = m.indices[t * 3 + k], v = m.indices[t * 3 + (k + 1) % 3]
      if (u === v) continue
      const key = edgeKey(u, v, n)
      cnt.set(key, (cnt.get(key) ?? 0) + 1)
      if (u < v) fwd.set(key, (fwd.get(key) ?? 0) + 1)
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistentEdges = 0
  const bl: number[] = [], nl: number[] = [], il: number[] = []
  const pushEdge = (arr: number[], key: number) => {
    const a = Math.floor(key / n), b = key - a * n
    arr.push(p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2])
  }
  for (const [key, c] of cnt) {
    if (c === 1) {
      boundaryEdges++
      pushEdge(bl, key)
    } else if (c > 2) {
      nonManifoldEdges++
      pushEdge(nl, key)
    } else {
      const f = fwd.get(key) ?? 0
      if (f !== 1) {
        inconsistentEdges++
        pushEdge(il, key)
      }
    }
  }
  // shells and their signed volumes
  const shellVol = new Map<number, number>()
  const ox = p[0] ?? 0, oy = p[1] ?? 0, oz = p[2] ?? 0
  for (let t = 0; t < nt; t++) {
    const a = m.indices[t * 3] * 3, b = m.indices[t * 3 + 1] * 3, c = m.indices[t * 3 + 2] * 3
    const ax = p[a] - ox, ay = p[a + 1] - oy, az = p[a + 2] - oz
    const bx = p[b] - ox, by = p[b + 1] - oy, bz = p[b + 2] - oz
    const cx = p[c] - ox, cy = p[c + 1] - oy, cz = p[c + 2] - oz
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    const r = dsu.find(m.indices[t * 3])
    shellVol.set(r, (shellVol.get(r) ?? 0) + v)
  }
  let invertedShells = 0
  for (const v of shellVol.values()) if (v < 0) invertedShells++
  let unreferenced = 0
  for (let v = 0; v < n; v++) if (!used[v]) unreferenced++
  const bb = bbox(m)
  const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2])
  const mergeable = nt > 0 && n <= 1_500_000 ? n - unreferenced - (weldVertices(m, tolerance * Math.max(diag, 1e-9)).mesh.positions.length / 3) : 0
  return {
    vertices: n,
    triangles: nt,
    unreferenced,
    degenerate,
    duplicate,
    mergeable: Math.max(0, mergeable),
    edges: cnt.size,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    holes: boundaryEdges ? boundaryLoops(m).length : 0,
    shells: shellVol.size,
    invertedShells,
    volume: signedVolume(m),
    area: surfaceArea(m),
    min: bb.min,
    max: bb.max,
    watertight: nt > 0 && boundaryEdges === 0 && nonManifoldEdges === 0 && inconsistentEdges === 0,
    boundaryLines: Float32Array.from(bl),
    nonManifoldLines: Float32Array.from(nl),
    inconsistentLines: Float32Array.from(il),
  }
}

/** Number of distinct problem kinds found, for the badge in the UI. */
export function issueKinds(a: Analysis): number {
  return [a.boundaryEdges, a.nonManifoldEdges, a.inconsistentEdges, a.degenerate, a.duplicate, a.mergeable, a.invertedShells].filter((x) => x > 0).length
}
