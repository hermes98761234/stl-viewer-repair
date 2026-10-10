import Module, { type ManifoldToplevel } from 'manifold-3d'
import wasmUrl from 'manifold-3d/manifold.wasm?url'
import { parseModel, write3MF, writeSTL } from './lib/io'
import { compact, flipTriangles, type Mesh } from './lib/mesh'
import { dropNonManifold, fillHoles, libCheck, makeManifold, orientMesh, removeDegenerate, removeDuplicates, repairAll, weldVertices, type LibCheck, type LogEntry, type RepairOptions } from './lib/repair'
import { analyze, type Analysis } from './lib/topology'

export type Step = 'weld' | 'clean' | 'normals' | 'holes' | 'manifold' | 'flip' | 'all'

export type Req = { id: number } & (
  | { op: 'parse'; name: string; data: ArrayBuffer; tolerance: number }
  | { op: 'analyze'; mesh: Mesh; tolerance: number }
  | { op: 'repair'; step: Step; mesh: Mesh; opts: RepairOptions }
  | { op: 'export'; format: 'stl' | '3mf'; mesh: Mesh }
)

export interface Res {
  id: number
  error?: string
  mesh?: Mesh
  analysis?: Analysis
  lib?: LibCheck | null
  log?: LogEntry[]
  data?: ArrayBuffer
}

let wasmPromise: Promise<ManifoldToplevel | null> | null = null
function getWasm() {
  wasmPromise ??= Module({ locateFile: () => wasmUrl }).then(
    (w) => {
      w.setup()
      return w
    },
    () => null,
  )
  return wasmPromise
}

const T = (s: string, ...args: (string | number)[]): LogEntry => ({ msg: s, args })

async function describe(mesh: Mesh, tolerance: number): Promise<Pick<Res, 'mesh' | 'analysis' | 'lib'>> {
  const wasm = await getWasm()
  const analysis = analyze(mesh, tolerance)
  const lib = wasm && analysis.triangles < 3_000_000 ? libCheck(mesh, wasm) : null
  return { mesh, analysis, lib }
}

async function handle(req: Req): Promise<{ res: Res; transfer: Transferable[] }> {
  switch (req.op) {
    case 'parse': {
      const mesh = parseModel(req.name, req.data)
      return { res: { id: req.id, ...(await describe(mesh, req.tolerance)) }, transfer: [] }
    }
    case 'analyze':
      return { res: { id: req.id, ...(await describe(req.mesh, req.tolerance)) }, transfer: [] }
    case 'export': {
      if (req.format === 'stl') {
        const data = writeSTL(req.mesh)
        return { res: { id: req.id, data }, transfer: [data] }
      }
      const z = write3MF(req.mesh)
      const data = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
      return { res: { id: req.id, data }, transfer: [data] }
    }
    case 'repair': {
      const wasm = await getWasm()
      const { opts } = req
      let mesh = req.mesh
      let log: LogEntry[] = []
      switch (req.step) {
        case 'weld': {
          const r = weldVertices(mesh, opts.tolerance)
          mesh = r.mesh
          log = [T('Merged {0} duplicate vertices.', r.merged)]
          break
        }
        case 'clean': {
          const a = removeDegenerate(mesh)
          const b = removeDuplicates(a.mesh)
          mesh = compact(b.mesh)
          log = [T('Removed {0} degenerate triangles.', a.removed), T('Removed {0} duplicate triangles.', b.removed)]
          break
        }
        case 'normals': {
          const r = orientMesh(mesh)
          mesh = r.mesh
          log = [T('Reversed {0} triangles to fix normals.', r.flipped)]
          break
        }
        case 'holes': {
          const r = fillHoles(mesh, opts.maxHoleEdges)
          mesh = r.mesh
          log = [T('Filled {0} holes with {1} triangles.', r.filled, r.added)]
          if (r.skipped) log.push(T('Left {0} large holes open.', r.skipped))
          break
        }
        case 'manifold': {
          const nm = dropNonManifold(mesh)
          const r = makeManifold(nm.mesh, wasm)
          mesh = r.mesh
          log = [...(nm.removed ? [T('Removed {0} triangles on non-manifold edges.', nm.removed)] : []), ...r.log]
          if (!r.ok) log.push(T('Could not make the mesh manifold.'))
          break
        }
        case 'flip':
          mesh = flipTriangles(mesh)
          log = [T('Reversed all normals.')]
          break
        case 'all': {
          const r = repairAll(mesh, wasm, opts)
          mesh = r.mesh
          log = r.log
          if (opts.manifold && !r.ok) log.push(T('Could not make the mesh manifold.'))
          break
        }
      }
      return { res: { id: req.id, log, ...(await describe(mesh, opts.tolerance)) }, transfer: [] }
    }
  }
}

self.onmessage = (e: MessageEvent<Req>) => {
  handle(e.data).then(
    ({ res, transfer }) => {
      const a = res.analysis
      if (a) transfer.push(a.boundaryLines.buffer, a.nonManifoldLines.buffer, a.inconsistentLines.buffer)
      if (res.mesh) transfer.push(res.mesh.positions.buffer, res.mesh.indices.buffer)
      self.postMessage(res, { transfer })
    },
    (err: unknown) => self.postMessage({ id: e.data.id, error: err instanceof Error ? err.message : String(err) } satisfies Res),
  )
}
