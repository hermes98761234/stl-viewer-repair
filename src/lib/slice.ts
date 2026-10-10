import { edgeKey } from './topology'
import type { Axis, Mesh } from './mesh'

export interface Section {
  /** Closed contours in 3D. */
  loops: Float32Array[]
  /** Net enclosed area in the cutting plane (holes subtract). */
  area: number
  perimeter: number
}

/** Intersects the mesh with the plane `axis = offset` and chains the cut segments into closed loops. */
export function sliceMesh(m: Mesh, axis: Axis, offset: number): Section {
  const p = m.positions
  const n = p.length / 3
  const u = ((axis + 1) % 3) as Axis
  const v = ((axis + 2) % 3) as Axis
  const side = (i: number) => {
    const d = p[i * 3 + axis] - offset
    return d === 0 ? 1e-9 : d // vertices exactly on the plane count as slightly above it
  }
  const next = new Map<number, number>() // start edge key -> end edge key
  const point = new Map<number, [number, number, number]>()
  const edgePoint = (a: number, b: number, key: number) => {
    let q = point.get(key)
    if (!q) {
      const da = side(a), db = side(b)
      const s = da / (da - db)
      q = [p[a * 3] + (p[b * 3] - p[a * 3]) * s, p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * s, p[a * 3 + 2] + (p[b * 3 + 2] - p[a * 3 + 2]) * s]
      point.set(key, q)
    }
  }
  for (let t = 0; t < m.indices.length; t += 3) {
    let start = -1, end = -1
    for (let k = 0; k < 3; k++) {
      const a = m.indices[t + k], b = m.indices[t + (k + 1) % 3]
      const sa = side(a) > 0, sb = side(b) > 0
      if (sa === sb) continue
      const key = edgeKey(a, b, n)
      edgePoint(a, b, key)
      if (!sa && sb) start = key
      else end = key
    }
    if (start >= 0 && end >= 0) next.set(start, end)
  }
  const loops: Float32Array[] = []
  const visited = new Set<number>()
  let area = 0, perimeter = 0
  for (const s of next.keys()) {
    if (visited.has(s)) continue
    const keys: number[] = []
    let cur: number | undefined = s
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur)
      keys.push(cur)
      cur = next.get(cur)
    }
    if (cur !== s || keys.length < 3) continue // open chain: the mesh has a hole here
    const arr = new Float32Array(keys.length * 3)
    keys.forEach((k, i) => arr.set(point.get(k)!, i * 3))
    loops.push(arr)
    for (let i = 0; i < keys.length; i++) {
      const j = (i + 1) % keys.length
      area += (arr[i * 3 + u] * arr[j * 3 + v] - arr[j * 3 + u] * arr[i * 3 + v]) / 2
      perimeter += Math.hypot(arr[j * 3] - arr[i * 3], arr[j * 3 + 1] - arr[i * 3 + 1], arr[j * 3 + 2] - arr[i * 3 + 2])
    }
  }
  return { loops, area: Math.abs(area), perimeter }
}
