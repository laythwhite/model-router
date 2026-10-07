// Pure classification: no `$`, no I/O, so it is cheap and easy to test.

import {
  EFFORTS,
  EFFORT_DOWN,
  EFFORT_UP,
  FOLLOW_UP,
  MODEL_RANK,
  TIERS,
  type Effort,
  type ModelAlias,
  type TierName,
} from './routes'

export type Source = 'rules' | 'haiku' | 'follow-up' | 'override' | 'pin' | 'default'

export type Decision = {
  tier: TierName
  model: ModelAlias
  effort: Effort
  source: Source
  reasons: string[]
}

export type Classified = Decision & {
  // True when the rules could not tell tiers apart; the router may ask Haiku.
  isUnsure: boolean
}

export type ModelChoices = { designModel: ModelAlias; videoModel: ModelAlias }

export type Override = { model?: ModelAlias; tier?: TierName; effort?: Effort }

const TIER_NAMES = Object.keys(TIERS) as TierName[]
const MODEL_NAMES = Object.keys(MODEL_RANK) as ModelAlias[]

// When two tiers score the same, the earlier one here wins.
const TIE_ORDER: readonly TierName[] = ['video', 'build', 'design', 'standard', 'quick']

/**
 * Reads leading override tags such as `[opus]`, `[fable max]`, `[quick]` or
 * `[low]` and returns the prompt without them. Tags must open the prompt.
 */
export function parseOverride(text: string): { text: string; override: Override | null } {
  const match = /^\s*\[([a-z\s,+]+)\]\s*/i.exec(text)
  if (!match) return { text, override: null }

  const words = (match[1] ?? '').toLowerCase().split(/[\s,+]+/).filter(Boolean)
  const override: Override = {}
  for (const word of words) {
    if ((MODEL_NAMES as string[]).includes(word)) override.model = word as ModelAlias
    else if ((TIER_NAMES as string[]).includes(word)) override.tier = word as TierName
    else if ((EFFORTS as string[]).includes(word)) override.effort = word as Effort
    else return { text, override: null } // not ours: leave the prompt alone
  }
  return { text: text.slice(match[0].length), override }
}

export function score(text: string): Record<TierName, { score: number; why: string[] }> {
  const out = {} as Record<TierName, { score: number; why: string[] }>
  for (const name of TIER_NAMES) {
    const why: string[] = []
    let total = 0
    for (const rule of TIERS[name].rules) {
      if (rule.pattern.test(text)) {
        total += rule.weight
        if (!why.includes(rule.why)) why.push(rule.why)
      }
    }
    out[name] = { score: total, why }
  }
  return out
}

export function shiftEffort(effort: Effort, by: number, ceiling: Effort = 'xhigh'): Effort {
  const max = EFFORTS.indexOf(ceiling)
  const at = Math.min(max, Math.max(0, EFFORTS.indexOf(effort) + by))
  return EFFORTS[at] ?? effort
}

export function modelFor(tier: TierName, choices: ModelChoices): ModelAlias {
  if (tier === 'design') return choices.designModel
  if (tier === 'video') return choices.videoModel
  return TIERS[tier].model
}

export function effortNudge(text: string): { by: number; why?: string } {
  const up = EFFORT_UP.test(text) || text.length > 1200
  const down = EFFORT_DOWN.test(text)
  if (up && !down) return { by: 1, why: 'asks for depth' }
  if (down && !up) return { by: -1, why: 'asks for a quick pass' }
  return { by: 0 }
}

export function fromTier(tier: TierName, text: string, choices: ModelChoices, source: Source, reasons: string[]): Decision {
  const nudge = effortNudge(text)
  return {
    tier,
    model: modelFor(tier, choices),
    effort: shiftEffort(TIERS[tier].effort, nudge.by),
    source,
    reasons: nudge.why ? [...reasons, nudge.why] : reasons,
  }
}

export function classify(text: string, previous: Decision | null, choices: ModelChoices): Classified {
  const trimmed = text.trim()

  if (previous && trimmed.length <= 60 && FOLLOW_UP.test(trimmed)) {
    return { ...previous, source: 'follow-up', reasons: ['follow-up to the last task'], isUnsure: false }
  }

  const scores = score(trimmed)
  const ranked = [...TIER_NAMES].sort(
    (a, b) => scores[b].score - scores[a].score || TIE_ORDER.indexOf(a) - TIE_ORDER.indexOf(b),
  )
  const top = ranked[0] ?? 'standard'
  const second = ranked[1] ?? 'quick'
  const best = scores[top].score
  const runnerUp = scores[second].score

  if (best === 0) {
    // Nothing matched: short questions are quick, anything longer is standard.
    const tier: TierName = trimmed.length <= 80 ? 'quick' : 'standard'
    return { ...fromTier(tier, trimmed, choices, 'default', ['no strong signal']), isUnsure: true }
  }

  const isSure = (best >= 3 && best - runnerUp >= 2) || (best >= 2 && runnerUp === 0)
  return { ...fromTier(top, trimmed, choices, 'rules', scores[top].why), isUnsure: !isSure }
}

export function applyOverride(base: Decision, override: Override, text: string, choices: ModelChoices): Decision {
  let decision = override.tier ? fromTier(override.tier, text, choices, 'override', [`[${override.tier}]`]) : base
  if (override.model) decision = { ...decision, model: override.model }
  if (override.effort) decision = { ...decision, effort: override.effort }
  return { ...decision, source: 'override', reasons: ['inline override'] }
}

// --- The Haiku tiebreaker ---------------------------------------------------

export const TIEBREAK_SYSTEM = [
  'You label tasks for a model router. Reply with exactly one word from:',
  'quick, standard, build, design, video.',
  'quick = admin, lookups, logging, tiny edits.',
  'standard = writing, messages, summaries, plans, production docs, small scripts.',
  'build = coding, websites, WordPress, apps, debugging, deploys.',
  'design = graphic design, layouts, brand assets, flyers, carousels, storyboards.',
  'video = AI video/image generation (Higgsfield, Seedance, Genjutsu), motion control.',
].join('\n')

export function tiebreakPrompt(text: string): string {
  const clipped = text.length > 1500 ? `${text.slice(0, 1500)}…` : text
  return `Task:\n"""\n${clipped}\n"""\nLabel:`
}

export function parseTiebreak(reply: string): TierName | null {
  const word = reply.trim().toLowerCase().match(/[a-z]+/)?.[0]
  return word && (TIER_NAMES as string[]).includes(word) ? (word as TierName) : null
}
