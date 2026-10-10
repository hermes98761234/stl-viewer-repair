import type { ManifoldToplevel } from 'manifold-3d'
import { boundaryLoops, edgeKey, isDegenerate } from './topology'
import { compact, triArea, type Mesh } from './mesh'
import { weldVertices } from './weld'

export { weldVertices }

/** One line of the repair log. `msg` is an English template for `tr()`. */
export interface LogEntry {
  msg: string
  args: (string | number)[]
}
const log = (msg: string, ...args: (string | number)[]): LogEntry => ({ msg, args })

function keepTriangles(m: Mesh, keep: (t: number) => boolean): { mesh: Mesh; removed: number } {
  const out: number[] = []
  const nt = m.indices.length / 3
  for (let t = 0; t < nt; t++) if (keep(t)) out.push(m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2])
  return { mesh: { positions: m.positions, indices: Uint32Array.from(out) }, removed: nt - out.length / 3 }
}

export function removeDegenerate(m: Mesh, areaEps = 0) {
  return keepTriangles(m, (t) => !isDegenerate(m, t, areaEps))
}

/** Keeps the first of every group of triangles that share the same three vertices. */
export function removeDuplicates(m: Mesh) {
  const seen = new Set<string>()
  return keepTriangles(m, (t) => {
    const s = [m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]].sort((a, b) => a - b)
    const k = `${s[0]},${s[1]},${s[2]}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Makes neighbouring triangles agree on direction, then turns every patch inside-out if its volume is negative. */
export function orientMesh(m: Mesh): { mesh: Mesh; flipped: number } {
  const n = m.positions.length / 3
  const nt = m.indices.length / 3
  const edgeTris = new Map<number, number[]>()
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(m.indices[t * 3 + k], m.indices[t * 3 + (k + 1) % 3], n)
      const l = edgeTris.get(key)
      if (l) l.push(t)
      else edgeTris.set(key, [t])
    }
  }
  const hasDir = (t: number, u: number, v: number) => {
    for (let k = 0; k < 3; k++) if (m.indices[t * 3 + k] === u && m.indices[t * 3 + (k + 1) % 3] === v) return true
    return false
  }
  const flip = new Uint8Array(nt)
  const comp = new Int32Array(nt).fill(-1)
  const compFlipAll: boolean[] = []
  for (let s = 0; s < nt; s++) {
    if (comp[s] >= 0) continue
    const id = compFlipAll.length
    comp[s] = id
    const members = [s]
    for (let qi = 0; qi < members.length; qi++) {
      const t = members[qi]
      for (let k = 0; k < 3; k++) {
        const u = m.indices[t * 3 + k], v = m.indices[t * 3 + (k + 1) % 3]
        if (u === v) continue
        const l = edgeTris.get(edgeKey(u, v, n))!
        if (l.length !== 2) continue
        const o = l[0] === t ? l[1] : l[0]
        if (o === t || comp[o] >= 0) continue
        // direction of this edge in t after its own flip
        const tDirUV = flip[t] ? hasDir(t, v, u) : hasDir(t, u, v)
        const oDirUV = hasDir(o, u, v)
        // neighbours must use opposite directions
        flip[o] = tDirUV === oDirUV ? 1 : 0
        comp[o] = id
        members.push(o)
      }
    }
    // signed volume of this patch with its flips applied
    let vol = 0
    const p = m.positions
    for (const t of members) {
      const a = m.indices[t * 3] * 3
      const b = m.indices[t * 3 + (flip[t] ? 2 : 1)] * 3
      const c = m.indices[t * 3 + (flip[t] ? 1 : 2)] * 3
      vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
    }
    compFlipAll.push(vol < 0)
  }
  const indices = m.indices.slice()
  let flipped = 0
  for (let t = 0; t < nt; t++) {
    if ((flip[t] === 1) !== compFlipAll[comp[t]]) {
      indices[t * 3 + 1] = m.indices[t * 3 + 2]
      indices[t * 3 + 2] = m.indices[t * 3 + 1]
      flipped++
    }
  }
  return { mesh: { positions: m.positions, indices }, flipped }
}

/** Ear-clips a 3D polygon (vertex indices) into triangles that keep the polygon's winding. */
export function triangulatePolygon(p: Float32Array, poly: number[]): number[] {
  const n = poly.length
  if (n < 3) return []
  // Newell normal
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < n; i++) {
    const a = poly[i] * 3, b = poly[(i + 1) % n] * 3
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2])
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b])
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1])
  }
  const fan = () => {
    // fan around the centroid is not possible without a new vertex; fan from vertex 0
    const out: number[] = []
    for (let i = 1; i < n - 1; i++) out.push(poly[0], poly[i], poly[i + 1])
    return out
  }
  if (n > 1500 || (nx === 0 && ny === 0 && nz === 0)) return fan()
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz)
  // project dropping the dominant axis; keep orientation via the sign
  const sign = ax >= ay && ax >= az ? Math.sign(nx) : ay >= az ? Math.sign(ny) : Math.sign(nz)
  const pt = (v: number): [number, number] => {
    const o = v * 3
    if (ax >= ay && ax >= az) return [p[o + 1], p[o + 2]]
    if (ay >= az) return [p[o + 2], p[o]]
    return [p[o], p[o + 1]]
  }
  const P = poly.map(pt)
  const cross = (a: [number, number], b: [number, number], c: [number, number]) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * sign
  const idx = poly.map((_, i) => i)
  const out: number[] = []
  let guard = 0
  while (idx.length > 3 && guard++ < n * n) {
    let best = -1
    let bestScore = -Infinity
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length]
      const c = cross(P[i0], P[i1], P[i2])
      if (c <= 0) continue
      let inside = false
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue
        if (cross(P[i0], P[i1], P[j]) >= 0 && cross(P[i1], P[i2], P[j]) >= 0 && cross(P[i2], P[i0], P[j]) >= 0) {
          inside = true
          break
        }
      }
      if (inside) continue
      // prefer well-shaped ears
      const score = c / (Math.hypot(P[i1][0] - P[i0][0], P[i1][1] - P[i0][1]) * Math.hypot(P[i2][0] - P[i1][0], P[i2][1] - P[i1][1]) + 1e-30)
      if (score > bestScore) {
        bestScore = score
        best = i
        if (score > 0.5) break
      }
    }
    if (best < 0) {
      // no ear (self-touching loop): clip the sharpest convex vertex, or give up and fan the rest
      best = 0
    }
    const i0 = idx[(best + idx.length - 1) % idx.length], i1 = idx[best], i2 = idx[(best + 1) % idx.length]
    out.push(poly[i0], poly[i1], poly[i2])
    idx.splice(best, 1)
  }
  if (idx.length === 3) out.push(poly[idx[0]], poly[idx[1]], poly[idx[2]])
  return out
}

/** Closes boundary loops with ear-clipped patches. Loops longer than `maxEdges` are left open. */
export function fillHoles(m: Mesh, maxEdges = 5000): { mesh: Mesh; filled: number; skipped: number; added: number } {
  const loops = boundaryLoops(m)
  const extra: number[] = []
  let filled = 0, skipped = 0
  for (const loop of loops) {
    if (loop.length < 3 || loop.length > maxEdges) {
      skipped++
      continue
    }
    const tris = triangulatePolygon(m.positions, loop.slice().reverse())
    extra.push(...tris)
    filled++
  }
  const indices = new Uint32Array(m.indices.length + extra.length)
  indices.set(m.indices)
  indices.set(extra, m.indices.length)
  return { mesh: { positions: m.positions, indices }, filled, skipped, added: extra.length / 3 }
}

/** Where an edge is shared by 3+ triangles, keeps the two largest and drops the rest. */
export function dropNonManifold(m: Mesh): { mesh: Mesh; removed: number } {
  let cur = m
  let total = 0
  for (let pass = 0; pass < 6; pass++) {
    const n = cur.positions.length / 3
    const edgeTris = new Map<number, number[]>()
    for (let t = 0; t < cur.indices.length / 3; t++) {
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(cur.indices[t * 3 + k], cur.indices[t * 3 + (k + 1) % 3], n)
        const l = edgeTris.get(key)
        if (l) l.push(t)
        else edgeTris.set(key, [t])
      }
    }
    const drop = new Set<number>()
    for (const l of edgeTris.values()) {
      if (l.length <= 2) continue
      const live = l.filter((t) => !drop.has(t))
      if (live.length <= 2) continue
      const area = (t: number) => triArea(cur.positions, cur.indices[t * 3], cur.indices[t * 3 + 1], cur.indices[t * 3 + 2])
      // triangles whose other edges are properly paired belong to the main surface; loose fins score low
      const score = (t: number) => {
        let s = 0
        for (let k = 0; k < 3; k++) if (edgeTris.get(edgeKey(cur.indices[t * 3 + k], cur.indices[t * 3 + (k + 1) % 3], n))?.length === 2) s++
        return s
      }
      live.sort((a, b) => score(b) - score(a) || area(b) - area(a))
      for (const t of live.slice(2)) drop.add(t)
    }
    if (drop.size === 0) break
    const r = keepTriangles(cur, (t) => !drop.has(t))
    cur = r.mesh
    total += r.removed
  }
  return { mesh: cur, removed: total }
}

/** Removes triangles with an edge that lacks exactly one oppositely directed partner, until none is left. */
export function dropUnpaired(m: Mesh): { mesh: Mesh; removed: number } {
  let cur = m
  let total = 0
  for (let pass = 0; pass < 100; pass++) {
    const n = cur.positions.length / 3
    const dcount = new Map<number, number>()
    const dk = (u: number, v: number) => u * n + v
    for (let t = 0; t < cur.indices.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const key = dk(cur.indices[t + k], cur.indices[t + (k + 1) % 3])
        dcount.set(key, (dcount.get(key) ?? 0) + 1)
      }
    const r = keepTriangles(cur, (t) => {
      for (let k = 0; k < 3; k++) {
        const u = cur.indices[t * 3 + k], v = cur.indices[t * 3 + (k + 1) % 3]
        if (dcount.get(dk(u, v)) !== 1 || dcount.get(dk(v, u)) !== 1) return false
      }
      return true
    })
    if (r.removed === 0) break
    cur = r.mesh
    total += r.removed
  }
  return { mesh: cur, removed: total }
}

export interface LibCheck {
  valid: boolean
  status: string
  volume: number
  area: number
  genus: number
}

function toWasmMesh(wasm: ManifoldToplevel, m: Mesh) {
  return new wasm.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices })
}

/** Asks Manifold whether it accepts the mesh as a valid solid, and what it measures. */
export function libCheck(m: Mesh, wasm: ManifoldToplevel): LibCheck {
  if (m.indices.length === 0) return { valid: false, status: 'Empty', volume: 0, area: 0, genus: 0 }
  try {
    const man = new wasm.Manifold(toWasmMesh(wasm, m))
    const status = man.status()
    const r = { valid: status === 'NoError' && !man.isEmpty(), status, volume: man.volume(), area: man.surfaceArea(), genus: man.genus() }
    man.delete()
    return r
  } catch (e) {
    return { valid: false, status: String((e as Error).message ?? e), volume: 0, area: 0, genus: 0 }
  }
}

/** Runs the mesh through Manifold, which returns a clean, guaranteed-manifold copy. */
function viaManifold(m: Mesh, wasm: ManifoldToplevel): Mesh | null {
  try {
    const man = new wasm.Manifold(toWasmMesh(wasm, m))
    if (man.status() !== 'NoError' || man.isEmpty()) {
      man.delete()
      return null
    }
    const out = man.getMesh()
    const mesh: Mesh = { positions: new Float32Array(out.numVert * 3), indices: Uint32Array.from(out.triVerts) }
    for (let v = 0; v < out.numVert; v++) mesh.positions.set(out.vertProperties.subarray(v * out.numProp, v * out.numProp + 3), v * 3)
    man.delete()
    return mesh
  } catch {
    return null
  }
}

/** Drops non-manifold geometry, patches what is left open and hands the result to Manifold to confirm it is a solid. */
export function makeManifold(input: Mesh, wasm: ManifoldToplevel | null): { mesh: Mesh; ok: boolean; log: LogEntry[] } {
  const entries: LogEntry[] = []
  let cur = input
  const nm = dropNonManifold(cur)
  if (nm.removed) entries.push(log('Removed {0} triangles on non-manifold edges.', nm.removed))
  cur = nm.mesh
  for (let round = 0; round < 3; round++) {
    cur = compact(orientMesh(cur).mesh)
    const f = fillHoles(cur)
    if (f.filled === 0) break
    cur = f.mesh
  }
  cur = compact(orientMesh(cur).mesh)
  if (!wasm) {
    const un = dropUnpaired(cur)
    return { mesh: compact(un.mesh), ok: un.removed === 0, log: entries }
  }
  let out = viaManifold(cur, wasm)
  if (!out) {
    const un = dropUnpaired(cur)
    if (un.removed) entries.push(log('Removed {0} triangles that Manifold could not pair up.', un.removed))
    cur = compact(un.mesh)
    out = viaManifold(cur, wasm)
  }
  if (!out) return { mesh: cur, ok: false, log: entries }
  entries.push(log('Manifold accepted the mesh: {0} triangles.', out.indices.length / 3))
  return { mesh: out, ok: true, log: entries }
}

export interface RepairOptions {
  /** Vertices closer than this merge (model units). */
  tolerance: number
  maxHoleEdges: number
  manifold: boolean
}

/** The recommended pipeline: merge, clean, orient, fill holes, make manifold. */
export function repairAll(input: Mesh, wasm: ManifoldToplevel | null, opts: RepairOptions): { mesh: Mesh; log: LogEntry[]; ok: boolean } {
  const entries: LogEntry[] = []
  const w = weldVertices(input, opts.tolerance)
  entries.push(log('Merged {0} duplicate vertices.', w.merged))
  let cur = w.mesh
  const dg = removeDegenerate(cur)
  entries.push(log('Removed {0} degenerate triangles.', dg.removed))
  const dp = removeDuplicates(dg.mesh)
  entries.push(log('Removed {0} duplicate triangles.', dp.removed))
  const nm = dropNonManifold(dp.mesh)
  entries.push(log('Removed {0} triangles on non-manifold edges.', nm.removed))
  const or = orientMesh(nm.mesh)
  entries.push(log('Reversed {0} triangles to fix normals.', or.flipped))
  const fh = fillHoles(or.mesh, opts.maxHoleEdges)
  entries.push(log('Filled {0} holes with {1} triangles.', fh.filled, fh.added))
  if (fh.skipped) entries.push(log('Left {0} large holes open.', fh.skipped))
  cur = orientMesh(fh.mesh).mesh
  let ok = false
  if (opts.manifold) {
    const mm = makeManifold(cur, wasm)
    entries.push(...mm.log)
    cur = mm.mesh
    ok = mm.ok
  } else {
    cur = compact(cur)
  }
  return { mesh: cur, log: entries, ok }
}

