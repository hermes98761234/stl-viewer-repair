import { compact, type Mesh } from './mesh'

/** Merges vertices closer than `tol` (a tolerance of 0 merges only identical positions). Unused vertices are dropped. */
export function weldVertices(input: Mesh, tol: number): { mesh: Mesh; merged: number } {
  const m = compact(input)
  const n = m.positions.length / 3
  const p = m.positions
  const cell = tol > 0 ? tol : 1e-12
  const buckets = new Map<number, number[]>()
  const remap = new Uint32Array(n)
  const reps: number[] = [] // original index of every kept vertex
  const hash = (x: number, y: number, z: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0
  const t2 = tol * tol
  for (let v = 0; v < n; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2]
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell), iz = Math.floor(z / cell)
    let found = -1
    search: for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(hash(ix + dx, iy + dy, iz + dz))
          if (!list) continue
          for (const r of list) {
            const o = reps[r] * 3
            const ex = p[o] - x, ey = p[o + 1] - y, ez = p[o + 2] - z
            if (tol > 0 ? ex * ex + ey * ey + ez * ez <= t2 : ex === 0 && ey === 0 && ez === 0) {
              found = r
              break search
            }
          }
        }
    if (found < 0) {
      found = reps.length
      reps.push(v)
      const h = hash(ix, iy, iz)
      const l = buckets.get(h)
      if (l) l.push(found)
      else buckets.set(h, [found])
    }
    remap[v] = found
  }
  const positions = new Float32Array(reps.length * 3)
  reps.forEach((v, i) => positions.set(p.subarray(v * 3, v * 3 + 3), i * 3))
  const indices = new Uint32Array(m.indices.length)
  for (let i = 0; i < indices.length; i++) indices[i] = remap[m.indices[i]]
  return { mesh: { positions, indices }, merged: n - reps.length }
}
