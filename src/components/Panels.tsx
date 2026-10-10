import { useState } from 'react'
import { fmtArea, fmtLen, fmtNum, fmtVol, type Unit } from '../format'
import type { T } from '../i18n'
import type { Axis, Mesh, Vec3 } from '../lib/mesh'
import { bbox } from '../lib/mesh'
import type { LibCheck, LogEntry } from '../lib/repair'
import type { Section } from '../lib/slice'
import type { Analysis } from '../lib/topology'
import type { Settings } from '../state'
import type { Step } from '../worker'

export function NumField({ value, onChange, label, step, min }: { value: number; onChange: (v: number) => void; label: string; step?: number; min?: number }) {
  const [text, setText] = useState(String(value))
  const [last, setLast] = useState(value)
  if (value !== last) {
    setLast(value)
    setText(String(value))
  }
  const n = Number(text)
  const bad = text.trim() === '' || !Number.isFinite(n) || (min !== undefined && n < min)
  return (
    <div className="field">
      <label>
        {label}
        <input
          type="number"
          inputMode="decimal"
          value={text}
          step={step}
          className={bad ? 'bad' : ''}
          onChange={(e) => {
            setText(e.target.value)
            const v = Number(e.target.value)
            if (e.target.value.trim() !== '' && Number.isFinite(v) && (min === undefined || v >= min)) {
              setLast(v)
              onChange(v)
            }
          }}
        />
      </label>
    </div>
  )
}

const Row = ({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) => (
  <tr>
    <td>{k}</td>
    <td className={cls}>{v}</td>
  </tr>
)

export function InfoPanel({ name, a, lib, unit, t }: { name: string; a: Analysis; lib: LibCheck | null; unit: Unit; t: T }) {
  const size = [a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]]
  const closed = a.watertight
  return (
    <table className="data">
      <tbody>
        <Row k={t('File')} v={name} />
        <Row k={t('Triangles')} v={a.triangles.toLocaleString()} />
        <Row k={t('Vertices')} v={a.vertices.toLocaleString()} />
        <Row k={t('Size X × Y × Z')} v={size.map((s) => fmtNum(unit === 'in' ? s / 25.4 : s, 4)).join(' × ') + (unit === 'in' ? ' in' : ' mm')} />
        <Row k={t('Surface area')} v={fmtArea(a.area, unit)} />
        <Row k={closed ? t('Volume') : t('Volume (approximate, mesh is open)')} v={fmtVol(a.volume, unit)} cls={closed ? undefined : 'warn-text'} />
        <Row k={t('Shells')} v={a.shells} />
        {lib?.valid && <Row k={t('Genus (holes through)')} v={lib.genus} />}
        <Row k={t('Lowest / highest point')} v={`${fmtLen(a.min[2], unit)} / ${fmtLen(a.max[2], unit)}`} />
      </tbody>
    </table>
  )
}

interface IssueDef {
  key: string
  count: number
  label: string
  hint: string
  swatch?: string
  step: Step
  action: string
}

export function IssuesPanel({
  a,
  lib,
  busy,
  log,
  settings,
  onStep,
  onSettings,
  t,
}: {
  a: Analysis
  lib: LibCheck | null
  busy: boolean
  log: LogEntry[]
  settings: Settings
  onStep: (s: Step) => void
  onSettings: (p: Partial<Settings>) => void
  t: T
}) {
  const issues: IssueDef[] = [
    { key: 'merge', count: a.mergeable, label: t('Duplicate vertices'), hint: t('Vertices that sit on top of each other but are not joined, so the surface looks torn.'), step: 'weld', action: t('Merge vertices') },
    { key: 'deg', count: a.degenerate + a.duplicate, label: t('Degenerate or repeated triangles'), hint: t('Zero-area slivers and triangles listed more than once.'), step: 'clean', action: t('Remove them') },
    { key: 'holes', count: a.holes, label: t('Holes'), hint: t('Open loops where the surface is missing ({0} boundary edges).', a.boundaryEdges), swatch: '#ff2d2d', step: 'holes', action: t('Fill holes') },
    { key: 'norm', count: a.inconsistentEdges + a.invertedShells, label: t('Flipped normals'), hint: t('Triangles facing the wrong way ({0} edges disagree, {1} inside-out shells). Shown red when viewed from behind.', a.inconsistentEdges, a.invertedShells), swatch: '#ffd400', step: 'normals', action: t('Fix normals') },
    { key: 'nm', count: a.nonManifoldEdges, label: t('Non-manifold edges'), hint: t('Edges shared by three or more triangles, such as a fin sticking out of a wall.'), swatch: '#ff00ff', step: 'manifold', action: t('Make manifold') },
  ]
  const found = issues.filter((i) => i.count > 0)
  return (
    <div>
      <p className={`verdict ${a.watertight && lib?.valid !== false ? 'ok' : 'err'}`}>
        {a.watertight
          ? lib && !lib.valid
            ? t('Closed, but Manifold rejects it: {0}', lib.status)
            : t('Watertight and manifold. Ready to print.')
          : t('{0} kinds of problems found.', found.length)}
      </p>
      {found.length > 0 && (
        <ul className="issues">
          {found.map((i) => (
            <li key={i.key}>
              <div className="row">
                {i.swatch && <span className="swatch" style={{ background: i.swatch }} />}
                <strong>
                  {i.label}: {i.count.toLocaleString()}
                </strong>
                <span className="spacer" />
                <button className="small" disabled={busy} onClick={() => onStep(i.step)}>
                  {i.action}
                </button>
              </div>
              <p className="hint">{i.hint}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => onStep('all')}>
          {t('Repair all')}
        </button>
        <button disabled={busy} onClick={() => onStep('manifold')} title={t('Drops non-manifold geometry, patches holes and lets Manifold confirm a valid solid.')}>
          {t('Make manifold')}
        </button>
        <button disabled={busy} onClick={() => onStep('flip')}>
          {t('Flip all normals')}
        </button>
      </div>
      <div className="grid2">
        <NumField label={t('Merge tolerance (mm)')} value={settings.tolerance} min={0} step={0.001} onChange={(v) => onSettings({ tolerance: v })} />
        <NumField label={t('Largest hole to fill (edges)')} value={settings.maxHole} min={3} step={100} onChange={(v) => onSettings({ maxHole: Math.round(v) })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={settings.showIssues} onChange={(e) => onSettings({ showIssues: e.target.checked })} /> {t('Highlight problems in the 3D view')}
      </label>
      {lib && (
        <p className="hint">
          {t('Manifold library check')}: {lib.valid ? t('valid solid') : t('not a valid solid ({0})', lib.status)}
        </p>
      )}
      {log.length > 0 && (
        <ul className="log">
          {log.map((l, i) => (
            <li key={i}>{t(l.msg, ...l.args)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export interface SectionState {
  on: boolean
  axis: Axis
  /** 0..1 along the model's extent on the chosen axis. */
  pos: number
  hideAbove: boolean
}

export function SectionPanel({ s, onChange, mesh, section, unit, t }: { s: SectionState; onChange: (p: Partial<SectionState>) => void; mesh: Mesh; section: Section | null; unit: Unit; t: T }) {
  const { min, max } = bbox(mesh)
  const off = min[s.axis] + s.pos * (max[s.axis] - min[s.axis])
  return (
    <div>
      <label className="check">
        <input type="checkbox" checked={s.on} onChange={(e) => onChange({ on: e.target.checked })} /> {t('Show a cross-section')}
      </label>
      {s.on && (
        <>
          <div className="row">
            {(['X', 'Y', 'Z'] as const).map((n, i) => (
              <button key={n} className={s.axis === i ? 'active' : ''} aria-pressed={s.axis === i} onClick={() => onChange({ axis: i as Axis })}>
                {n}
              </button>
            ))}
            <span className="spacer" />
            <span>{fmtLen(off, unit)}</span>
          </div>
          <input type="range" min={0} max={1} step={0.002} value={s.pos} aria-label={t('Cut position')} onChange={(e) => onChange({ pos: +e.target.value })} style={{ width: '100%' }} />
          <label className="check">
            <input type="checkbox" checked={s.hideAbove} onChange={(e) => onChange({ hideAbove: e.target.checked })} /> {t('Hide the part above the cut')}
          </label>
          {section && (
            <table className="data">
              <tbody>
                <Row k={t('Section area')} v={fmtArea(section.area, unit)} />
                <Row k={t('Outline length')} v={fmtLen(section.perimeter, unit)} />
                <Row k={t('Closed outlines')} v={section.loops.length} />
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}

export function MeasurePanel({ on, onToggle, points, onClear, unit, t }: { on: boolean; onToggle: (b: boolean) => void; points: Vec3[]; onClear: () => void; unit: Unit; t: T }) {
  const d = points.length === 2 ? points[1].map((v, i) => v - points[0][i]) : null
  return (
    <div>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} /> {t('Measure: click two points on the model')}
      </label>
      {on && points.length < 2 && <p className="hint">{points.length === 0 ? t('Click the first point.') : t('Click the second point.')}</p>}
      {d && (
        <table className="data">
          <tbody>
            <Row k={t('Distance')} v={<strong>{fmtLen(Math.hypot(d[0], d[1], d[2]), unit)}</strong>} />
            <Row k="ΔX" v={fmtLen(Math.abs(d[0]), unit)} />
            <Row k="ΔY" v={fmtLen(Math.abs(d[1]), unit)} />
            <Row k="ΔZ" v={fmtLen(Math.abs(d[2]), unit)} />
          </tbody>
        </table>
      )}
      {points.length > 0 && (
        <button className="small" onClick={onClear}>
          {t('Clear')}
        </button>
      )}
    </div>
  )
}

export type TransformOp =
  | { kind: 'scale'; s: [number, number, number] }
  | { kind: 'rotate'; axis: Axis; deg: number }
  | { kind: 'mirror'; axis: Axis }
  | { kind: 'bed' }

export function TransformPanel({ busy, onApply, t }: { busy: boolean; onApply: (op: TransformOp) => void; t: T }) {
  const [f, setF] = useState<[number, number, number]>([1, 1, 1])
  const [uniform, setUniform] = useState(true)
  const [axis, setAxis] = useState<Axis>(2)
  const [deg, setDeg] = useState(45)
  const setFactor = (i: number, v: number) => setF((cur) => (uniform ? [v, v, v] : (cur.map((x, j) => (j === i ? v : x)) as [number, number, number])))
  const ok = f.every((x) => x > 0)
  return (
    <div>
      <h4>{t('Scale')}</h4>
      <div className="grid3">
        {(['X', 'Y', 'Z'] as const).map((n, i) => (
          <NumField key={n} label={n} value={f[i]} step={0.1} onChange={(v) => setFactor(i, v)} />
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} /> {t('Uniform')}
      </label>
      <div className="row">
        <button disabled={busy || !ok} onClick={() => onApply({ kind: 'scale', s: f })}>
          {t('Apply scale')}
        </button>
        <button className="small" disabled={busy} onClick={() => onApply({ kind: 'scale', s: [25.4, 25.4, 25.4] })} title={t('The file was drawn in inches')}>
          {t('in → mm (×25.4)')}
        </button>
        <button className="small" disabled={busy} onClick={() => onApply({ kind: 'scale', s: [1 / 25.4, 1 / 25.4, 1 / 25.4] })}>
          {t('mm → in (÷25.4)')}
        </button>
        <button className="small" disabled={busy} onClick={() => onApply({ kind: 'scale', s: [10, 10, 10] })}>
          {t('cm → mm (×10)')}
        </button>
      </div>
      <h4>{t('Rotate')}</h4>
      <div className="row">
        {(['X', 'Y', 'Z'] as const).map((n, i) => (
          <span key={n} className="btn-pair">
            <button className="small" disabled={busy} onClick={() => onApply({ kind: 'rotate', axis: i as Axis, deg: -90 })}>
              {n} −90°
            </button>
            <button className="small" disabled={busy} onClick={() => onApply({ kind: 'rotate', axis: i as Axis, deg: 90 })}>
              {n} +90°
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <select value={axis} aria-label={t('Axis')} onChange={(e) => setAxis(+e.target.value as Axis)}>
          <option value={0}>X</option>
          <option value={1}>Y</option>
          <option value={2}>Z</option>
        </select>
        <input type="number" value={deg} aria-label={t('Angle in degrees')} onChange={(e) => setDeg(+e.target.value)} style={{ width: 80 }} />
        <button disabled={busy || !Number.isFinite(deg)} onClick={() => onApply({ kind: 'rotate', axis, deg })}>
          {t('Rotate')}
        </button>
      </div>
      <h4>{t('Position')}</h4>
      <div className="row">
        <button disabled={busy} onClick={() => onApply({ kind: 'bed' })}>
          {t('Centre on bed (Z = 0)')}
        </button>
        {(['X', 'Y', 'Z'] as const).map((n, i) => (
          <button key={n} className="small" disabled={busy} onClick={() => onApply({ kind: 'mirror', axis: i as Axis })}>
            {t('Mirror {0}', n)}
          </button>
        ))}
      </div>
    </div>
  )
}
