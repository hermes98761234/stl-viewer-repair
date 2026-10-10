/** Indexed triangle mesh. Triangles are counter-clockwise seen from outside. */
export interface Mesh {
  /** x, y, z per vertex. */
  positions: Float32Array
  /** Three vertex indices per triangle. */
  indices: Uint32Array
}

export type Vec3 = [number, number, number]
export type Axis = 0 | 1 | 2

export const emptyMesh = (): Mesh => ({ positions: new Float32Array(0), indices: new Uint32Array(0) })
export const triCount = (m: Mesh) => m.indices.length / 3
export const vertCount = (m: Mesh) => m.positions.length / 3

export function bbox(m: Mesh): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  const p = m.positions
  const used = new Uint8Array(p.length / 3)
  for (let i = 0; i < m.indices.length; i++) used[m.indices[i]] = 1
  for (let v = 0; v < used.length; v++) {
    if (!used[v]) continue
    for (let k = 0; k < 3; k++) {
      const x = p[v * 3 + k]
      if (x < min[k]) min[k] = x
      if (x > max[k]) max[k] = x
    }
  }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] }
  return { min, max }
}

/** Signed volume (positive when the normals point outwards) by the divergence theorem. */
export function signedVolume(m: Mesh): number {
  const p = m.positions
  const ox = p[0] ?? 0
  const oy = p[1] ?? 0
  const oz = p[2] ?? 0
  let vol = 0
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3
    const b = m.indices[t + 1] * 3
    const c = m.indices[t + 2] * 3
    const ax = p[a] - ox, ay = p[a + 1] - oy, az = p[a + 2] - oz
    const bx = p[b] - ox, by = p[b + 1] - oy, bz = p[b + 2] - oz
    const cx = p[c] - ox, cy = p[c + 1] - oy, cz = p[c + 2] - oz
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return vol / 6
}

export function triArea(p: Float32Array, a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
  return 0.5 * Math.sqrt(x * x + y * y + z * z)
}

export function surfaceArea(m: Mesh): number {
  let s = 0
  for (let t = 0; t < m.indices.length; t += 3) s += triArea(m.positions, m.indices[t], m.indices[t + 1], m.indices[t + 2])
  return s
}

/** Reverses the winding of every triangle (or only of the listed ones). */
export function flipTriangles(m: Mesh, which?: Set<number>): Mesh {
  const indices = m.indices.slice()
  for (let t = 0; t < indices.length / 3; t++) {
    if (which && !which.has(t)) continue
    const tmp = indices[t * 3 + 1]
    indices[t * 3 + 1] = indices[t * 3 + 2]
    indices[t * 3 + 2] = tmp
  }
  return { positions: m.positions, indices }
}

/** Applies a 3x3 linear map then a translation; mirrors flip the winding to keep normals outwards. */
export function applyLinear(m: Mesh, mat: number[], shift: Vec3 = [0, 0, 0]): Mesh {
  const p = m.positions
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2]
    out[i] = mat[0] * x + mat[1] * y + mat[2] * z + shift[0]
    out[i + 1] = mat[3] * x + mat[4] * y + mat[5] * z + shift[1]
    out[i + 2] = mat[6] * x + mat[7] * y + mat[8] * z + shift[2]
  }
  const det =
    mat[0] * (mat[4] * mat[8] - mat[5] * mat[7]) - mat[1] * (mat[3] * mat[8] - mat[5] * mat[6]) + mat[2] * (mat[3] * mat[7] - mat[4] * mat[6])
  const r: Mesh = { positions: out, indices: m.indices }
  return det < 0 ? flipTriangles(r) : r
}

export function scaleMesh(m: Mesh, sx: number, sy = sx, sz = sx): Mesh {
  return applyLinear(m, [sx, 0, 0, 0, sy, 0, 0, 0, sz])
}

export function rotateMesh(m: Mesh, axis: Axis, degrees: number): Mesh {
  const a = (degrees * Math.PI) / 180
  const c = Math.cos(a), s = Math.sin(a)
  const mat = axis === 0 ? [1, 0, 0, 0, c, -s, 0, s, c] : axis === 1 ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1]
  return applyLinear(m, mat)
}

export function mirrorMesh(m: Mesh, axis: Axis): Mesh {
  const mat = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  mat[axis * 4] = -1
  return applyLinear(m, mat)
}

/** Centres the model on X/Y and rests its lowest point on Z=0. */
export function placeOnBed(m: Mesh): Mesh {
  const { min, max } = bbox(m)
  return applyLinear(m, [1, 0, 0, 0, 1, 0, 0, 0, 1], [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]])
}

/** Drops unused vertices and renumbers. */
export function compact(m: Mesh): Mesh {
  const map = new Int32Array(m.positions.length / 3).fill(-1)
  let n = 0
  const indices = new Uint32Array(m.indices.length)
  for (let i = 0; i < m.indices.length; i++) {
    const v = m.indices[i]
    if (map[v] < 0) map[v] = n++
    indices[i] = map[v]
  }
  const positions = new Float32Array(n * 3)
  for (let v = 0; v < map.length; v++) {
    const j = map[v]
    if (j >= 0) positions.set(m.positions.subarray(v * 3, v * 3 + 3), j * 3)
  }
  return { positions, indices }
}

/** Builds an indexed mesh from a triangle soup, merging bit-identical vertices. */
export function fromSoup(coords: ArrayLike<number>): Mesh {
  const n = Math.floor(coords.length / 9) * 3
  const f = new Float32Array(1)
  const u = new Uint32Array(f.buffer)
  const seen = new Map<string, number>()
  const pos: number[] = []
  const indices = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const x = coords[i * 3], y = coords[i * 3 + 1], z = coords[i * 3 + 2]
    f[0] = x + 0
    const kx = u[0]
    f[0] = y + 0
    const ky = u[0]
    f[0] = z + 0
    const key = `${kx},${ky},${u[0]}`
    let idx = seen.get(key)
    if (idx === undefined) {
      idx = pos.length / 3
      seen.set(key, idx)
      pos.push(x, y, z)
    }
    indices[i] = idx
  }
  return { positions: Float32Array.from(pos), indices }
}
