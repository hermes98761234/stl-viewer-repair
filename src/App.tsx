import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import Viewer from './components/Viewer'
import { InfoPanel, IssuesPanel, MeasurePanel, SectionPanel, TransformPanel, type SectionState, type TransformOp } from './components/Panels'
import { Engine } from './engine'
import { tr, type T } from './i18n'
import { bbox, mirrorMesh, placeOnBed, rotateMesh, scaleMesh, type Mesh, type Vec3 } from './lib/mesh'
import type { LibCheck, LogEntry } from './lib/repair'
import { makeSample, type SampleId } from './lib/shapes'
import { sliceMesh } from './lib/slice'
import type { Analysis } from './lib/topology'
import { loadSettings, saveSettings, type Settings } from './state'
import type { Res, Step } from './worker'

interface Doc {
  mesh: Mesh
  analysis: Analysis
  lib: LibCheck | null
  label: string
}

const SAMPLES: { id: SampleId; name: string; label: string }[] = [
  { id: 'damaged', name: 'damaged-sphere.stl', label: 'Damaged sphere' },
  { id: 'finned', name: 'inside-out-cube.stl', label: 'Inside-out cube with a fin' },
  { id: 'torus', name: 'torus.stl', label: 'Healthy torus' },
]

const download = (data: BlobPart, name: string, type: string) => {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [hist, setHist] = useState<Doc[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>('Loading…')
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [fitKey, setFitKey] = useState(0)
  const [section, setSection] = useState<SectionState>({ on: false, axis: 2, pos: 0.5, hideAbove: true })
  const [measureOn, setMeasureOn] = useState(false)
  const [points, setPoints] = useState<Vec3[]>([])
  const [dragging, setDragging] = useState(false)
  const engine = useRef<Engine | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const t: T = (s, ...a) => tr(settings.lang, s, ...a)
  const doc = hist[hist.length - 1] ?? null

  const run = useCallback(async <R,>(label: string, job: () => Promise<R>): Promise<R | undefined> => {
    setBusy(label)
    setError(null)
    try {
      return await job()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    } finally {
      setBusy(null)
    }
  }, [])

  const eng = () => (engine.current ??= new Engine())

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'auto') delete root.dataset.theme
    else root.dataset.theme = settings.theme
    root.lang = settings.lang
  }, [settings.theme, settings.lang])

  const accept = (r: Res, label: string): Doc => ({ mesh: r.mesh!, analysis: r.analysis!, lib: r.lib ?? null, label })

  const open = useCallback(
    (mesh: Doc | null, fileName: string) => {
      if (!mesh) return
      setHist([mesh])
      setName(fileName)
      setLog([])
      setPoints([])
      setFitKey((k) => k + 1)
      setSection((s) => ({ ...s, pos: 0.5 }))
    },
    [],
  )

  const loadFile = useCallback(
    async (file: File) => {
      const r = await run('Reading the file…', async () => {
        const data = await file.arrayBuffer()
        return eng().run({ op: 'parse', name: file.name, data, tolerance: settings.tolerance }, [data])
      })
      if (r) open(accept(r, file.name), file.name)
    },
    [run, open, settings.tolerance],
  )

  const loadSample = useCallback(
    async (id: SampleId) => {
      const s = SAMPLES.find((x) => x.id === id)!
      const mesh = makeSample(id)
      const r = await run('Analysing…', () => eng().run({ op: 'analyze', mesh, tolerance: settings.tolerance }))
      if (r) open(accept({ ...r, mesh }, s.name), s.name)
    },
    [run, open, settings.tolerance],
  )

  useEffect(() => {
    const timer = setTimeout(() => void loadSample('damaged'), 0)
    return () => {
      clearTimeout(timer)
      engine.current?.dispose()
      engine.current = null
    }
    // first load only
    // eslint-disable-next-line
  }, [])

  const push = (d: Doc | null, entries: LogEntry[] = []) => {
    if (!d) return
    setHist((h) => [...h, d])
    setLog(entries)
  }

  const repair = async (step: Step) => {
    if (!doc) return
    const r = await run('Repairing…', () =>
      eng().run({ op: 'repair', step, mesh: doc.mesh, opts: { tolerance: settings.tolerance, maxHoleEdges: settings.maxHole, manifold: true } }),
    )
    if (r) push(accept(r, step), r.log)
  }

  const transform = async (op: TransformOp) => {
    if (!doc) return
    const m = doc.mesh
    const next =
      op.kind === 'scale' ? scaleMesh(m, ...op.s) : op.kind === 'rotate' ? rotateMesh(m, op.axis, op.deg) : op.kind === 'mirror' ? mirrorMesh(m, op.axis) : placeOnBed(m)
    const r = await run('Analysing…', () => eng().run({ op: 'analyze', mesh: next, tolerance: settings.tolerance }))
    if (r) {
      push(accept({ ...r, mesh: next }, op.kind), [])
      setPoints([])
    }
  }

  const undo = () => {
    setHist((h) => (h.length > 1 ? h.slice(0, -1) : h))
    setLog([])
    setPoints([])
  }

  const exportAs = async (format: 'stl' | '3mf') => {
    if (!doc) return
    const r = await run('Exporting…', () => eng().run({ op: 'export', format, mesh: doc.mesh }))
    if (r?.data) {
      const base = name.replace(/\.[^.]+$/, '') || 'model'
      download(r.data, `${base}${hist.length > 1 ? '-repaired' : ''}.${format}`, format === 'stl' ? 'model/stl' : 'model/3mf')
    }
  }

  const onPick = useCallback(
    (p: Vec3) => {
      if (measureOn) setPoints((cur) => (cur.length >= 2 ? [p] : [...cur, p]))
    },
    [measureOn],
  )

  const deferredPos = useDeferredValue(section.pos)
  const range = useMemo(() => (doc ? bbox(doc.mesh) : null), [doc])
  const offset = range ? range.min[section.axis] + deferredPos * (range.max[section.axis] - range.min[section.axis]) : 0
  const cut = useMemo(() => (doc && section.on ? sliceMesh(doc.mesh, section.axis, offset) : null), [doc, section.on, section.axis, offset])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) void loadFile(f)
  }

  const a = doc?.analysis ?? null
  const problems = a && !a.watertight

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <header className="toolbar">
        <span className="brand">{t('STL Viewer & Repair')}</span>
        <span className="hint">{t('Inspect, repair and measure 3D-print meshes. Nothing leaves your browser.')}</span>
        <span className="spacer" />
        <input ref={fileInput} type="file" hidden accept=".stl,.obj,.3mf" onChange={(e) => e.target.files?.[0] && void loadFile(e.target.files[0])} onClick={(e) => ((e.target as HTMLInputElement).value = '')} />
        <button className="primary" onClick={() => fileInput.current?.click()}>
          {t('Open file')}
        </button>
        <select
          aria-label={t('Example models')}
          value=""
          onChange={(e) => e.target.value && void loadSample(e.target.value as SampleId)}
        >
          <option value="">{t('Examples…')}</option>
          {SAMPLES.map((s) => (
            <option key={s.id} value={s.id}>
              {t(s.label)}
            </option>
          ))}
        </select>
        <button disabled={hist.length < 2 || !!busy} onClick={undo}>
          {t('Undo')}
        </button>
        <button disabled={!doc || !!busy} onClick={() => void exportAs('stl')}>
          {t('Export STL')}
        </button>
        <button disabled={!doc || !!busy} onClick={() => void exportAs('3mf')}>
          {t('Export 3MF')}
        </button>
      </header>
      <div className="body">
        <main className="main">
          <Viewer
            mesh={doc?.mesh ?? null}
            fitKey={fitKey}
            analysis={a}
            showIssues={settings.showIssues}
            wireframe={settings.wireframe}
            theme={settings.theme}
            clip={{ axis: section.axis, offset, on: section.on && section.hideAbove }}
            section={cut?.loops ?? []}
            measure={points}
            onPick={onPick}
            t={t}
          >
            <div className="viewport-status" aria-live="polite">
              {busy ? <span className="chip">{t(busy)}</span> : a && <span className={`chip ${problems ? 'bad' : 'good'}`}>{problems ? t('Needs repair') : t('Watertight')}</span>}
              {error && <span className="chip bad">{t('Error: {0}', error)}</span>}
            </div>
            <div className="legend">
              <label className="check">
                <input type="checkbox" checked={settings.wireframe} onChange={(e) => setSettings({ ...settings, wireframe: e.target.checked })} /> {t('Wireframe')}
              </label>
              <span><i style={{ background: '#e5484d' }} />{t('back face')}</span>
              <span><i style={{ background: '#ff2d2d' }} />{t('hole edge')}</span>
              <span><i style={{ background: '#ff00ff' }} />{t('non-manifold')}</span>
              <span><i style={{ background: '#ffd400' }} />{t('flipped')}</span>
            </div>
            {dragging && <div className="drop">{t('Drop the file to open it')}</div>}
          </Viewer>
        </main>
        <aside className="side">
          <div className="panel">
            <details open>
              <summary>{t('Model')}</summary>
              {doc && a ? <InfoPanel name={name} a={a} lib={doc.lib} unit={settings.unit} t={t} /> : <p className="hint">{t('No model loaded.')}</p>}
            </details>
            <details open>
              <summary>
                {t('Problems and repair')}
                {a && <span className={`badge ${a.watertight ? 'good' : 'bad'}`}>{a.watertight ? '✓' : '!'}</span>}
              </summary>
              {doc && a && <IssuesPanel a={a} lib={doc.lib} busy={!!busy} log={log} settings={settings} onStep={(s) => void repair(s)} onSettings={(p) => setSettings({ ...settings, ...p })} t={t} />}
            </details>
            <details>
              <summary>{t('Cross-section')}</summary>
              {doc && <SectionPanel s={section} onChange={(p) => setSection({ ...section, ...p })} mesh={doc.mesh} section={cut} unit={settings.unit} t={t} />}
            </details>
            <details>
              <summary>{t('Measure')}</summary>
              <MeasurePanel on={measureOn} onToggle={(b) => { setMeasureOn(b); setPoints([]) }} points={points} onClear={() => setPoints([])} unit={settings.unit} t={t} />
            </details>
            <details>
              <summary>{t('Scale, rotate, position')}</summary>
              <TransformPanel busy={!!busy || !doc} onApply={(op) => void transform(op)} t={t} />
            </details>
            <details>
              <summary>{t('Settings')}</summary>
              <div className="grid3">
                <div className="field">
                  <label>
                    {t('Units')}
                    <select value={settings.unit} onChange={(e) => setSettings({ ...settings, unit: e.target.value as Settings['unit'] })}>
                      <option value="mm">{t('Millimetres')}</option>
                      <option value="in">{t('Inches')}</option>
                    </select>
                  </label>
                </div>
                <div className="field">
                  <label>
                    {t('Theme')}
                    <select value={settings.theme} onChange={(e) => setSettings({ ...settings, theme: e.target.value as Settings['theme'] })}>
                      <option value="auto">{t('System')}</option>
                      <option value="light">{t('Light')}</option>
                      <option value="dark">{t('Dark')}</option>
                    </select>
                  </label>
                </div>
                <div className="field">
                  <label>
                    {t('Language')}
                    <select value={settings.lang} onChange={(e) => setSettings({ ...settings, lang: e.target.value as Settings['lang'] })}>
                      <option value="en">English</option>
                      <option value="uk">Українська</option>
                    </select>
                  </label>
                </div>
              </div>
            </details>
          </div>
        </aside>
      </div>
      <p className="hint foot">
        {t('Everything runs locally in your browser. The mesh is checked with exact edge pairing and the Manifold library.')}{' '}
        <a href="https://github.com/hermes98761234/stl-viewer-repair">{t('Source on GitHub')}</a>
      </p>
    </div>
  )
}
