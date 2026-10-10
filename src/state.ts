import type { Unit } from './format'

export type Lang = 'en' | 'uk'
export type Theme = 'auto' | 'light' | 'dark'

export interface Settings {
  lang: Lang
  theme: Theme
  unit: Unit
  /** Vertices closer than this (mm) are merged by the repair. */
  tolerance: number
  /** Holes with more edges than this are left open. */
  maxHole: number
  showIssues: boolean
  wireframe: boolean
}

const KEY = 'stl-viewer-repair:v1'

export const defaultSettings = (): Settings => ({
  lang: typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('uk') ? 'uk' : 'en',
  theme: 'auto',
  unit: 'mm',
  tolerance: 0.001,
  maxHole: 2000,
  showIssues: true,
  wireframe: false,
})

export function loadSettings(): Settings {
  const d = defaultSettings()
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>
    return {
      lang: raw.lang === 'en' || raw.lang === 'uk' ? raw.lang : d.lang,
      theme: raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'auto' ? raw.theme : d.theme,
      unit: raw.unit === 'in' || raw.unit === 'mm' ? raw.unit : d.unit,
      tolerance: typeof raw.tolerance === 'number' && raw.tolerance >= 0 && raw.tolerance < 100 ? raw.tolerance : d.tolerance,
      maxHole: typeof raw.maxHole === 'number' && raw.maxHole >= 3 ? raw.maxHole : d.maxHole,
      showIssues: typeof raw.showIssues === 'boolean' ? raw.showIssues : d.showIssues,
      wireframe: typeof raw.wireframe === 'boolean' ? raw.wireframe : d.wireframe,
    }
  } catch {
    return d
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // storage may be unavailable (private mode); settings just won't persist
  }
}
