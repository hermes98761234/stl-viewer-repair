import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { fromSoup, triCount, type Mesh } from './mesh'

export type Format = 'stl' | 'obj' | '3mf'

export function detectFormat(name: string, data: ArrayBuffer): Format {
  const head = new Uint8Array(data, 0, Math.min(4, data.byteLength))
  if (head[0] === 0x50 && head[1] === 0x4b) return '3mf'
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'obj') return 'obj'
  if (ext === '3mf') return '3mf'
  if (ext === 'stl') return 'stl'
  const text = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(2000, data.byteLength)))
  if (/^\s*(v|f|#|o|g)\s/m.test(text) && !/^\s*solid/.test(text)) return 'obj'
  return 'stl'
}

export function parseModel(name: string, data: ArrayBuffer): Mesh {
  const mesh = (() => {
    switch (detectFormat(name, data)) {
      case '3mf':
        return parse3MF(data)
      case 'obj':
        return parseOBJ(new TextDecoder().decode(data))
      default:
        return parseSTL(data)
    }
  })()
  if (triCount(mesh) === 0) throw new Error('No triangles found in this file.')
  return mesh
}

export function parseSTL(data: ArrayBuffer): Mesh {
  const view = new DataView(data)
  if (data.byteLength >= 84) {
    const n = view.getUint32(80, true)
    const binarySize = 84 + n * 50
    const head = new TextDecoder().decode(new Uint8Array(data, 0, 5))
    // some exporters write "solid" in the binary header, so trust the size first
    if (binarySize === data.byteLength || (head !== 'solid' && binarySize <= data.byteLength)) {
      const soup = new Float32Array(n * 9)
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12
        for (let k = 0; k < 9; k++) soup[i * 9 + k] = view.getFloat32(o + k * 4, true)
      }
      return fromSoup(soup)
    }
  }
  const text = new TextDecoder().decode(data)
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g
  const coords: number[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) coords.push(+m[1], +m[2], +m[3])
  return fromSoup(coords)
}

export function parseOBJ(text: string): Mesh {
  const pos: number[] = []
  const idx: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.split(/\s+/)
      pos.push(+x, +y, +z)
    } else if (line.startsWith('f ')) {
      const nv = pos.length / 3
      const ids = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((tok) => {
          const i = parseInt(tok.split('/')[0], 10)
          return i < 0 ? nv + i : i - 1
        })
      for (let i = 1; i < ids.length - 1; i++) idx.push(ids[0], ids[i], ids[i + 1])
    }
  }
  const nv = pos.length / 3
  for (const i of idx) if (!(i >= 0 && i < nv)) throw new Error('OBJ face refers to a missing vertex.')
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 }
const attr = (s: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1]

/** Reads every mesh object of a 3MF package into one mesh (build transforms are ignored). Units become millimetres. */
export function parse3MF(data: ArrayBuffer): Mesh {
  const files = unzipSync(new Uint8Array(data))
  const names = Object.keys(files).filter((n) => n.toLowerCase().endsWith('.model'))
  if (names.length === 0) throw new Error('This 3MF has no model part.')
  const pos: number[] = []
  const idx: number[] = []
  for (const name of names) {
    const xml = strFromU8(files[name])
    const scale = UNIT_MM[attr(/<model\b[^>]*>/.exec(xml)?.[0] ?? '', 'unit') ?? 'millimeter'] ?? 1
    const meshRe = /<mesh\b[\s\S]*?<\/mesh>/g
    for (let mm = meshRe.exec(xml); mm; mm = meshRe.exec(xml)) {
      const base = pos.length / 3
      for (const v of mm[0].matchAll(/<vertex\b([^>]*)>/g)) pos.push(+(attr(v[1], 'x') ?? 0) * scale, +(attr(v[1], 'y') ?? 0) * scale, +(attr(v[1], 'z') ?? 0) * scale)
      for (const t of mm[0].matchAll(/<triangle\b([^>]*)>/g)) idx.push(base + +(attr(t[1], 'v1') ?? 0), base + +(attr(t[1], 'v2') ?? 0), base + +(attr(t[1], 'v3') ?? 0))
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** Binary STL with face normals. */
export function writeSTL(m: Mesh, header = 'stl-viewer-repair'): ArrayBuffer {
  const n = triCount(m)
  const buf = new ArrayBuffer(84 + n * 50)
  const view = new DataView(buf)
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode(header.slice(0, 79)))
  view.setUint32(80, n, true)
  const p = m.positions
  for (let t = 0; t < n; t++) {
    const a = m.indices[t * 3] * 3, b = m.indices[t * 3 + 1] * 3, c = m.indices[t * 3 + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    const o = 84 + t * 50
    view.setFloat32(o, nx, true)
    view.setFloat32(o + 4, ny, true)
    view.setFloat32(o + 8, nz, true)
    const vs = [a, b, c]
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) view.setFloat32(o + 12 + (k * 3 + j) * 4, p[vs[k] + j], true)
  }
  return buf
}

const num = (x: number) => String(+x.toPrecision(9))

export function write3MF(m: Mesh): Uint8Array {
  const v: string[] = []
  for (let i = 0; i < m.positions.length; i += 3) v.push(`<vertex x="${num(m.positions[i])}" y="${num(m.positions[i + 1])}" z="${num(m.positions[i + 2])}"/>`)
  const t: string[] = []
  for (let i = 0; i < m.indices.length; i += 3) t.push(`<triangle v1="${m.indices[i]}" v2="${m.indices[i + 1]}" v3="${m.indices[i + 2]}"/>`)
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources><object id="1" type="model"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object></resources>` +
    `<build><item objectid="1"/></build></model>`
  return zipSync({
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ),
    '3D/3dmodel.model': strToU8(model),
  })
}
