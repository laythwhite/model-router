import { describe, expect, test } from 'claude-code/testing'

import { classify, parseOverride, parseTiebreak, shiftEffort } from '../hooks/classify'
import type { TierName } from '../hooks/routes'

const choices = { designModel: 'fable', videoModel: 'opus' } as const

// Real-shaped asks from Sebastian's week, and where each should land.
const CASES: readonly [string, TierName][] = [
  ['add my miles: drove from the studio to Target for a prop run', 'quick'],
  ['HR flagged a missed punch yesterday, I forgot to clock out', 'quick'],
  ['fix the typo in the hero headline', 'quick'],
  ['draft a Feishu message to Siyu about the shoot moving to Friday', 'standard'],
  ['write a 30 second script for a reel about the calorie calculator', 'standard'],
  ['summarize these meeting notes and pull my action items', 'standard'],
  ['the booking scheduler on trivux pro is broken, members get a PHP error', 'build'],
  ['update the website pricing page template and deploy it live', 'build'],
  ['refactor the members app roster component', 'build'],
  ['design an Instagram carousel for Elite Summer Performance', 'design'],
  ['make a new pricing flyer with the brand kit, bold typography', 'design'],
  ['build the brand system: logo lockups, color palette, type pairing', 'design'],
  ['generate a Seedance 2.5 hero video of the BGC II bodysuit', 'video'],
  ['use Genjutsu motion transfer on this clip with our model', 'video'],
  ['make a b-roll clip for the MistWeave launch on Higgsfield', 'video'],
]

describe('classify', () => {
  for (const [prompt, tier] of CASES) {
    test(`${tier}: ${prompt}`, () => {
      expect(classify(prompt, null, choices).tier).toBe(tier)
    })
  }

  test('a short follow-up keeps the previous route', () => {
    const first = classify('fix the PHP error on the theme', null, choices)
    const next = classify('yes do it', first, choices)
    expect(next.tier).toBe('build')
    expect(next.model).toBe('opus')
    expect(next.source).toBe('follow-up')
  })

  test('nothing matched and short means quick, and unsure', () => {
    const c = classify('what do we have tomorrow?', null, choices)
    expect(c.tier).toBe('quick')
    expect(c.isUnsure).toBe(true)
  })

  test('asking for depth raises effort, never the model', () => {
    const c = classify('rebuild the entire website theme from scratch, production-ready', null, choices)
    expect(c.model).toBe('opus')
    expect(c.effort).toBe('xhigh')
  })

  test('the video tier follows the configured model', () => {
    const c = classify('Seedance video of the product', null, { designModel: 'fable', videoModel: 'fable' })
    expect(c.model).toBe('fable')
  })
})

describe('overrides', () => {
  test('leading tags are read and stripped', () => {
    const { text, override } = parseOverride('[fable max] redo the flyer')
    expect(text).toBe('redo the flyer')
    expect(override).toEqual({ model: 'fable', effort: 'max' })
  })

  test('a bracket that is not ours is left alone', () => {
    const { text, override } = parseOverride('[WIP] notes for Ricardo')
    expect(override).toBe(null)
    expect(text).toBe('[WIP] notes for Ricardo')
  })

  test('tiebreak replies parse to a tier', () => {
    expect(parseTiebreak(' Build.')).toBe('build')
    expect(parseTiebreak('maybe')).toBe(null)
  })

  test('effort shifts stay within the scale', () => {
    expect(shiftEffort('low', -1)).toBe('low')
    expect(shiftEffort('xhigh', 1)).toBe('xhigh')
    expect(shiftEffort('medium', 1)).toBe('high')
  })
})
