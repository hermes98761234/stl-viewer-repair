import type { Req, Res } from './worker'

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never

/** Runs jobs one after another in a module Web Worker. */
export class Engine {
  private worker: Worker
  private nextId = 1
  private waiting = new Map<number, { ok: (r: Res) => void; fail: (e: Error) => void }>()

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<Res>) => {
      const w = this.waiting.get(e.data.id)
      if (!w) return
      this.waiting.delete(e.data.id)
      if (e.data.error) w.fail(new Error(e.data.error))
      else w.ok(e.data)
    }
    this.worker.onerror = (e) => {
      for (const w of this.waiting.values()) w.fail(new Error(e.message || 'Worker failed'))
      this.waiting.clear()
    }
  }

  run(req: Distribute<Req>, transfer: Transferable[] = []): Promise<Res> {
    const id = this.nextId++
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail })
      this.worker.postMessage({ ...req, id }, transfer)
    })
  }

  dispose() {
    this.worker.terminate()
  }
}
