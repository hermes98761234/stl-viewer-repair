export type Unit = 'mm' | 'in'

const MM_PER_IN = 25.4

export function fmtNum(x: number, digits = 4): string {
  if (!Number.isFinite(x)) return '-'
  if (x === 0) return '0'
  const a = Math.abs(x)
  return a >= 1e6 || a < 1e-3 ? x.toExponential(digits - 1) : String(+x.toPrecision(digits))
}

/** Lengths are stored in millimetres. */
export function fmtLen(mm: number, unit: Unit): string {
  return unit === 'in' ? `${fmtNum(mm / MM_PER_IN)} in` : `${fmtNum(mm)} mm`
}

export function fmtArea(mm2: number, unit: Unit): string {
  return unit === 'in' ? `${fmtNum(mm2 / MM_PER_IN ** 2)} in²` : `${fmtNum(mm2 / 100)} cm²`
}

export function fmtVol(mm3: number, unit: Unit): string {
  return unit === 'in' ? `${fmtNum(mm3 / MM_PER_IN ** 3)} in³` : `${fmtNum(mm3 / 1000)} cm³`
}

export const toUnit = (mm: number, unit: Unit) => (unit === 'in' ? mm / MM_PER_IN : mm)
export const fromUnit = (v: number, unit: Unit) => (unit === 'in' ? v * MM_PER_IN : v)
