import { useEffect, useRef, useState } from 'react'
import type { Axis, Mesh, Vec3 } from '../lib/mesh'
import type { Analysis } from '../lib/topology'
import type { T } from '../i18n'
import { SceneController } from './scene'

export interface ViewerProps {
  mesh: Mesh | null
  /** Changes when a different model is loaded, to refit the camera. */
  fitKey: number
  analysis: Analysis | null
  showIssues: boolean
  wireframe: boolean
  theme: string
  clip: { axis: Axis; offset: number; on: boolean }
  section: Float32Array[]
  measure: Vec3[]
  onPick: (p: Vec3) => void
  t: T
  children?: React.ReactNode
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export default function Viewer(p: ViewerProps) {
  const host = useRef<HTMLDivElement>(null)
  const ctl = useRef<SceneController | null>(null)
  const pick = useRef(p.onPick)
  const [failed] = useState(() => !webglAvailable())

  useEffect(() => {
    pick.current = p.onPick
  })
  useEffect(() => {
    if (!host.current || failed) return
    ctl.current = new SceneController(host.current, (pt) => pick.current(pt))
    return () => {
      ctl.current?.dispose()
      ctl.current = null
    }
  }, [failed])
  const lastFit = useRef(-1)
  useEffect(() => {
    if (!p.mesh || !ctl.current) return
    ctl.current.setMesh(p.mesh, lastFit.current !== p.fitKey)
    lastFit.current = p.fitKey
  }, [p.mesh, p.fitKey])
  useEffect(() => ctl.current?.setOverlays(p.analysis, p.showIssues), [p.analysis, p.showIssues])
  useEffect(() => ctl.current?.setWireframe(p.wireframe), [p.wireframe])
  useEffect(() => ctl.current?.setClip(p.clip.axis, p.clip.offset, p.clip.on), [p.clip.axis, p.clip.offset, p.clip.on, p.mesh])
  useEffect(() => ctl.current?.setSection(p.section), [p.section])
  useEffect(() => ctl.current?.setMeasure(p.measure), [p.measure])
  useEffect(() => ctl.current?.setTheme(), [p.theme])

  return (
    <div className="viewport">
      <div ref={host} className="viewport-gl" role="img" aria-label={p.t('3D view of the model')} />
      {failed && <div className="scene-msg">{p.t('WebGL is not available in this browser.')}</div>}
      {!p.mesh && !failed && <div className="scene-msg">{p.t('Open or drop an STL, OBJ or 3MF file.')}</div>}
      <div className="viewport-tools">
        <button className="small" onClick={() => ctl.current?.resetView()} title={p.t('Reset view')}>
          {p.t('Reset view')}
        </button>
        <button
          className="small"
          onClick={() => {
            const a = document.createElement('a')
            a.href = ctl.current?.snapshot() ?? ''
            a.download = 'view.png'
            a.click()
          }}
        >
          {p.t('Save view as PNG')}
        </button>
      </div>
      {p.children}
    </div>
  )
}
