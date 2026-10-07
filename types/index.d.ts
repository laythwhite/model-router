export type RouterTier = 'quick' | 'standard' | 'build' | 'design' | 'video'
export type RouterModel = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type RouterEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RouterMode = 'auto' | 'suggest' | 'off'

/** The route chosen for the latest prompt. */
export type RouterDecision = {
  tier: RouterTier
  model: RouterModel
  effort: RouterEffort
  source: 'rules' | 'haiku' | 'follow-up' | 'override' | 'pin' | 'default'
  reasons: string[]
}

/** What a turn was locked to at its first step, so it never switches mid-turn. */
export type RouterLock = {
  turnId: string
  model: string
  effort: RouterEffort
  note: string
}

/** A `/route pin` that holds until `/route unpin`. */
export type RouterPin = {
  model?: RouterModel
  tier?: RouterTier
  effort?: RouterEffort
}

/** The main thread's last request: how big its context was and who served it. */
export type RouterContext = {
  tokens: number
  model: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      decision: RouterDecision | null
      lock: RouterLock | null
      pin: RouterPin | null
      mode: RouterMode | null
      context: RouterContext | null
      unavailable: string[]
    }
  }
}
