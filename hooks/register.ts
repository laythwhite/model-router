import type { EngineInterface, PluginOptions, Register, TurnStepInput, TurnStepResult } from 'claude-code'

import type { RouterContext, RouterDecision, RouterLock, RouterMode, RouterPin } from '../types'
import {
  applyOverride,
  classify,
  fromTier,
  parseOverride,
  parseTiebreak,
  TIEBREAK_SYSTEM,
  tiebreakPrompt,
  type ModelChoices,
} from './classify'
import { MODEL_IDS, MODEL_LABEL, MODEL_RANK, TIERS, type ModelAlias } from './routes'

const DECISION = { plugin: 'model-router', key: 'decision' } as const
const LOCK = { plugin: 'model-router', key: 'lock' } as const
const PIN = { plugin: 'model-router', key: 'pin' } as const
const MODE = { plugin: 'model-router', key: 'mode' } as const
const CONTEXT = { plugin: 'model-router', key: 'context' } as const
const UNAVAILABLE = { plugin: 'model-router', key: 'unavailable' } as const

type Stat = { turns: number; steps: number; input: number; output: number; cacheRead: number; cacheWrite: number }
type Stats = { since: string; models: Record<string, Stat>; tiers: Record<string, number>; tiebreaks: number }

const STATS_KEY = 'stats'
const ROUTED_FROM = new Set(['composer', 'bridge', 'sdk'])

// --- small helpers ------------------------------------------------------------

function aliasOf(modelId: string): ModelAlias | null {
  for (const alias of Object.keys(MODEL_IDS) as ModelAlias[]) {
    if (modelId === MODEL_IDS[alias] || modelId.includes(alias)) return alias
  }
  return null
}

function labelOf(modelId: string): string {
  const alias = aliasOf(modelId)
  return alias ? MODEL_LABEL[alias] : modelId
}

function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function readOptions(options: PluginOptions) {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(String(options[key])) ? (String(options[key]) as T) : fallback
  const guard = Number(options.cacheGuardTokens)
  return {
    mode: pick<RouterMode>('mode', ['auto', 'suggest', 'off'], 'auto'),
    tiebreaker: pick('tiebreaker', ['haiku', 'off'] as const, 'haiku'),
    choices: {
      designModel: pick<ModelAlias>('designModel', ['fable', 'opus', 'sonnet'], 'fable'),
      videoModel: pick<ModelAlias>('videoModel', ['opus', 'fable', 'sonnet'], 'opus'),
    } satisfies ModelChoices,
    cacheGuardTokens: Number.isFinite(guard) && guard >= 0 ? guard : 30000,
  }
}

function emptyStats(now: number): Stats {
  return { since: new Date(now).toISOString().slice(0, 10), models: {}, tiers: {}, tiebreaks: 0 }
}

async function loadStats($: EngineInterface): Promise<Stats> {
  const raw = (await $.store.get(STATS_KEY)) as Stats | undefined
  return raw && typeof raw === 'object' && raw.models ? raw : emptyStats(await $.clock.now())
}

function statusText(decision: RouterDecision, mode: RouterMode, lock?: RouterLock | null): string {
  const tier = TIERS[decision.tier].label
  if (mode === 'suggest') return `router suggests ${MODEL_LABEL[decision.model]} · ${decision.effort} · ${tier}`
  if (lock) return `⇢ ${labelOf(lock.model)} · ${lock.effort} · ${tier}${lock.note ? ` (${lock.note})` : ''}`
  return `⇢ ${MODEL_LABEL[decision.model]} · ${decision.effort} · ${tier}`
}

// Steps a model the account cannot use up the ladder (then down) to one it can.
function avoidUnavailable(decision: RouterDecision, unavailable: readonly string[]): RouterDecision {
  if (!unavailable.includes(MODEL_IDS[decision.model])) return decision
  const ladder = (Object.keys(MODEL_RANK) as ModelAlias[]).sort((a, b) => {
    const da = MODEL_RANK[a] - MODEL_RANK[decision.model]
    const db = MODEL_RANK[b] - MODEL_RANK[decision.model]
    return Math.abs(da) - Math.abs(db) || db - da // nearest first, ties prefer the stronger
  })
  const usable = ladder.find(alias => !unavailable.includes(MODEL_IDS[alias]))
  return usable ? { ...decision, model: usable, reasons: [...decision.reasons, `${decision.model} unavailable`] } : decision
}

// --- per-step work ------------------------------------------------------------

type Config = ReturnType<typeof readOptions>
type Hints = { lastClearHintAt: number }

async function mode($: EngineInterface, config: Config): Promise<RouterMode> {
  return (await $.state.get(MODE)).value ?? config.mode
}

async function record($: EngineInterface, result: TurnStepResult, isFirstStep: boolean): Promise<void> {
  const usage = result.usage
  if (!usage) return
  const tokens =
    usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
  await $.state.set(CONTEXT, { tokens, model: usage.model } satisfies RouterContext)

  const stats = await loadStats($)
  const row = (stats.models[usage.model] ??= { turns: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  row.steps += 1
  if (isFirstStep) row.turns += 1
  row.input += usage.input_tokens
  row.output += usage.output_tokens
  row.cacheRead += usage.cache_read_input_tokens
  row.cacheWrite += usage.cache_creation_input_tokens
  await $.store.set(STATS_KEY, stats)
}

async function tiebreak($: EngineInterface, text: string) {
  const reply = await $.model.complete({
    model: 'haiku',
    system: TIEBREAK_SYSTEM,
    prompt: tiebreakPrompt(text),
    maxTokens: 8,
    effort: 'low',
    timeoutMs: 6000,
  })
  if (!reply.isAnswered) return null
  const stats = await loadStats($)
  stats.tiebreaks += 1
  await $.store.set(STATS_KEY, stats)
  return parseTiebreak(reply.text)
}

// Decides, once per turn at its first step, which model and effort the
// whole turn runs on. Switching inside a turn would forfeit the cache.
async function lockFor($: EngineInterface, e: TurnStepInput, config: Config, hints: Hints): Promise<RouterLock | null> {
  const held = (await $.state.get(LOCK)).value
  if (held && held.turnId === e.turnId) return held

  const decision = (await $.state.get(DECISION)).value
  if (!decision) return null

  const target = MODEL_IDS[decision.model]
  const context = (await $.state.get(CONTEXT)).value
  let model = target
  let note = ''

  // Cache guard: a big conversation is cached on the model that served it.
  // Moving it DOWN to a cheaper model re-bills all of it, which usually
  // costs more than the cheaper model saves. Moving UP is allowed: quality.
  if (config.cacheGuardTokens > 0 && context && context.model !== target && context.tokens >= config.cacheGuardTokens) {
    const servedAlias = aliasOf(context.model)
    if (servedAlias && MODEL_RANK[decision.model] < MODEL_RANK[servedAlias]) {
      model = context.model
      note = `kept warm, ${kTokens(context.tokens)} ctx`
      const now = await $.clock.now()
      if (decision.source === 'rules' && context.tokens >= config.cacheGuardTokens * 3 && now - hints.lastClearHintAt > 600_000) {
        hints.lastClearHintAt = now
        $.ui.toast(
          `New ${TIERS[decision.tier].label.toLowerCase()} task on a ${kTokens(context.tokens)} context: /clear first and it runs on ${MODEL_LABEL[decision.model]}.`,
        )
      }
    }
  }

  const lock: RouterLock = { turnId: e.turnId, model, effort: decision.effort, note }
  await $.state.set(LOCK, lock)

  const stats = await loadStats($)
  stats.tiers[decision.tier] = (stats.tiers[decision.tier] ?? 0) + 1
  await $.store.set(STATS_KEY, stats)
  return lock
}

// --- the module ---------------------------------------------------------------

export const register: Register = (on, options) => {
  const config = readOptions(options)
  const hints: Hints = { lastClearHintAt: 0 }

  // --- session start: the /route command --------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Model router: status, auto | suggest | off, pin <model|tier> [effort], unpin, stats, reset',
      argumentHint: '[auto|suggest|off|pin …|unpin|stats|reset]',
      immediate: true,
    })
    const decision = (await $.state.get(DECISION)).value
    if (decision) $.ui.status(statusText(decision, await mode($, config)))
    return next(e)
  })

  // --- every prompt: classify it -------------------------------------------------

  on('prompt.submit', async ($, e, next) => {
    // Only the person's own prompts start a route; a prompt folded into a
    // running turn, a task notification or a peer's message keeps the current one.
    if (!ROUTED_FROM.has(e.origin.kind) || e.turnId !== undefined) return next(e)

    const current = await mode($, config)
    if (current === 'off') return next(e)

    const { text, override } = parseOverride(e.text)
    const previous = (await $.state.get(DECISION)).value ?? null
    const pin: RouterPin | null = (await $.state.get(PIN)).value ?? null

    let decision: RouterDecision
    if (pin && (pin.model || pin.tier)) {
      decision = applyOverride(fromTier(pin.tier ?? 'standard', text, config.choices, 'pin', []), pin, text, config.choices)
      decision = { ...decision, source: 'pin', reasons: ['pinned with /route pin'] }
    } else {
      const classified = classify(text, previous, config.choices)
      const { isUnsure, ...base } = classified
      decision = base
      if (isUnsure && config.tiebreaker === 'haiku') {
        const tier = await tiebreak($, text)
        if (tier) decision = fromTier(tier, text, config.choices, 'haiku', ['Haiku tiebreak'])
      }
      if (pin?.effort) decision = { ...decision, effort: pin.effort }
    }
    if (override) decision = applyOverride(decision, override, text, config.choices)
    decision = avoidUnavailable(decision, (await $.state.get(UNAVAILABLE)).value ?? [])

    await $.state.set(DECISION, decision)
    $.ui.status(statusText(decision, current))

    return next(override ? { ...e, text } : e)
  }).catch(($, e, next) => next(e)) // a router failure never blocks a prompt

  // --- every model request: apply the route --------------------------------------

  on('turn.step', async function* ($, e, next) {
    // Subagents keep the model their definition names.
    if (e.agentId !== undefined) return yield* next(e)

    const current = await mode($, config)
    const lock = current === 'auto' ? await lockFor($, e, config, hints) : null

    if (!lock || (lock.model === e.model && lock.effort === e.effort)) {
      const stream = next(e)
      for await (const chunk of stream) yield chunk
      const result = await stream.result
      await record($, result, e.index === 0)
      return result
    }

    if (e.index === 0) {
      const decision = (await $.state.get(DECISION)).value
      if (decision) $.ui.status(statusText(decision, current, lock))
    }

    const routed: TurnStepInput = { ...e, model: lock.model, effort: lock.effort }
    let hasYielded = false
    let failed = false
    try {
      const stream = next(routed)
      for await (const chunk of stream) {
        hasYielded = true
        yield chunk
      }
      const result = await stream.result
      failed = !hasYielded && result.usage === null && result.stopReason === null
      if (!failed) {
        await record($, result, e.index === 0)
        return result
      }
    } catch (error) {
      if (hasYielded) throw error
      failed = true
    }

    // The routed model gave nothing back (not on this plan, or refused):
    // remember that for the session and run this step as the engine meant to.
    if (failed && !next.signal.aborted) {
      const unavailable = (await $.state.get(UNAVAILABLE)).value ?? []
      if (!unavailable.includes(lock.model)) await $.state.set(UNAVAILABLE, [...unavailable, lock.model])
      await $.state.set(LOCK, { ...lock, model: e.model, note: `${labelOf(lock.model)} unavailable` })
      $.ui.toast(`${labelOf(lock.model)} did not answer; running on ${labelOf(e.model)} and skipping it this session.`)
    }
    const stream = next(e)
    for await (const chunk of stream) yield chunk
    const result = await stream.result
    await record($, result, e.index === 0)
    return result
  })

  // --- /route ------------------------------------------------------------------

  on('command.run', { command: 'route' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)

    if (verb === 'auto' || verb === 'suggest' || verb === 'off') {
      await $.state.set(MODE, verb)
      $.ui.status(verb === 'off' ? undefined : `router: ${verb}`)
      const what = {
        auto: 'Routing every prompt automatically.',
        suggest: 'Suggest mode: the status line shows the route, the model is left alone.',
        off: 'Router off: the session model runs everything.',
      }[verb]
      return { text: what }
    }

    if (verb === 'pin') {
      const { override } = parseOverride(`[${rest.join(' ')}]`)
      if (!override) return { text: 'Pin what? e.g. /route pin opus, /route pin design, /route pin sonnet low' }
      await $.state.set(PIN, override)
      const parts = [override.tier, override.model, override.effort].filter(Boolean).join(' ')
      return { text: `Pinned: ${parts}. Every prompt routes there until /route unpin.` }
    }

    if (verb === 'unpin') {
      await $.state.set(PIN, null)
      return { text: 'Unpinned. Back to automatic routing.' }
    }

    if (verb === 'reset') {
      await $.state.set(PIN, null)
      await $.state.set(UNAVAILABLE, [])
      if (rest[0] === 'stats') await $.store.set(STATS_KEY, emptyStats(await $.clock.now()))
      return { text: `Pin and unavailable-model list cleared${rest[0] === 'stats' ? ', stats zeroed' : ''}.` }
    }

    if (verb === 'stats') {
      const stats = await loadStats($)
      const rows = Object.entries(stats.models).sort((a, b) => b[1].turns - a[1].turns)
      if (rows.length === 0) return { text: 'No routed turns recorded yet.' }
      const totalTurns = rows.reduce((n, [, s]) => n + s.turns, 0)
      const belowOpus = rows
        .filter(([id]) => {
          const alias = aliasOf(id)
          return alias !== null && MODEL_RANK[alias] < MODEL_RANK.opus
        })
        .reduce((n, [, s]) => n + s.turns, 0)
      const lines = [
        `Since ${stats.since}: ${totalTurns} turns, ${Math.round((100 * belowOpus) / Math.max(1, totalTurns))}% on a model cheaper than Opus.`,
        '',
        '| Model | Turns | Input | Output | Cache read | Cache write |',
        '| --- | ---: | ---: | ---: | ---: | ---: |',
        ...rows.map(
          ([id, s]) =>
            `| ${labelOf(id)} | ${s.turns} | ${kTokens(s.input)} | ${kTokens(s.output)} | ${kTokens(s.cacheRead)} | ${kTokens(s.cacheWrite)} |`,
        ),
        '',
        `Tiers: ${Object.entries(stats.tiers).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'} · Haiku tiebreaks: ${stats.tiebreaks}`,
      ]
      return { text: lines.join('\n') }
    }

    // Default: status.
    const current = await mode($, config)
    const decision = (await $.state.get(DECISION)).value
    const lock = (await $.state.get(LOCK)).value
    const pin = (await $.state.get(PIN)).value
    const context = (await $.state.get(CONTEXT)).value
    const unavailable = (await $.state.get(UNAVAILABLE)).value ?? []
    const lines = [
      `Mode: ${current}${pin ? ` · pinned to ${[pin.tier, pin.model, pin.effort].filter(Boolean).join(' ')}` : ''}`,
      decision
        ? `Last route: ${TIERS[decision.tier].label} → ${MODEL_LABEL[decision.model]} at ${decision.effort} (${decision.source}: ${decision.reasons.join(', ')})`
        : 'Last route: none yet',
      lock?.note ? `Applied: ${labelOf(lock.model)} at ${lock.effort} (${lock.note})` : '',
      context ? `Context: ${kTokens(context.tokens)} tokens on ${labelOf(context.model)}` : '',
      unavailable.length ? `Skipping: ${unavailable.map(labelOf).join(', ')}` : '',
      '',
      'Override one prompt by starting it with tags: [opus] [fable max] [quick] [sonnet low]',
    ]
    return { text: lines.filter((line, i) => line !== '' || i === 5).join('\n') }
  })
}
