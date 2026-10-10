import { describe, expect, it } from 'vitest'
import { fmtArea, fmtLen, fmtNum, fmtVol } from './format'
import { tr, UK } from './i18n'
import { defaultSettings } from './state'

const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join()

describe('i18n', () => {
  it('keeps placeholders in every translation', () => {
    for (const [en, uk] of Object.entries(UK)) {
      expect(uk.length, en).toBeGreaterThan(0)
      expect(placeholders(uk), en).toBe(placeholders(en))
    }
  })
  it('interpolates and falls back to English', () => {
    expect(tr('en', 'Merged {0} duplicate vertices.', 5)).toBe('Merged 5 duplicate vertices.')
    expect(tr('uk', 'Watertight')).toBe('Герметична')
    expect(tr('uk', 'Not translated {0}', 1)).toBe('Not translated 1')
  })
})

describe('formatting', () => {
  it('converts millimetres to display units', () => {
    expect(fmtLen(25.4, 'in')).toBe('1 in')
    expect(fmtLen(10, 'mm')).toBe('10 mm')
    expect(fmtVol(1000, 'mm')).toBe('1 cm³')
    expect(fmtVol(25.4 ** 3, 'in')).toBe('1 in³')
    expect(fmtArea(100, 'mm')).toBe('1 cm²')
    expect(fmtNum(1 / 3, 3)).toBe('0.333')
  })
  it('has sane defaults', () => {
    expect(defaultSettings().tolerance).toBeGreaterThan(0)
  })
})
