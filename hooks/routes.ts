// The routing table. This is the file to edit when you want to change which
// kinds of work go to which model. Patterns are matched case-insensitively
// against the prompt; each match adds its weight to that tier's score.

export type TierName = 'quick' | 'standard' | 'build' | 'design' | 'video'
export type ModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Full API ids. turn.step rewrites the request's model, so these must be ids
// the API accepts. Update here when a new model generation ships.
export const MODEL_IDS: Record<ModelAlias, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}

// Cheapest first. Used by the cache guard and the fallback when a model is
// not available on the account.
export const MODEL_RANK: Record<ModelAlias, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

export const MODEL_LABEL: Record<ModelAlias, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  fable: 'Fable',
}

export type Rule = { pattern: RegExp; weight: number; why: string }

export type Tier = {
  name: TierName
  label: string
  model: ModelAlias
  effort: Effort
  rules: readonly Rule[]
}

const r = (pattern: RegExp, weight: number, why: string): Rule => ({ pattern, weight, why })

export const TIERS: Record<TierName, Tier> = {
  // Admin and lookups: logging, status checks, renames, tiny edits.
  quick: {
    name: 'quick',
    label: 'Quick',
    model: 'haiku',
    effort: 'low',
    rules: [
      r(/\b(mileage|add my miles|log (this|the) trip|i drove (from|to))\b/i, 3, 'mileage log'),
      r(/\b(attendance|missed punch|clock(ed)?[- ]?(in|out)|punch(es)? (in|out)?)\b/i, 3, 'attendance'),
      r(/\b(typo|spelling|rename (this|the|it|file)|fix the wording)\b/i, 2, 'tiny edit'),
      r(/\b(git status|what branch|which file|where is (the|my)|list (the|my) (files|folders))\b/i, 2, 'lookup'),
      r(/\b(what('?s| is) (the )?(date|time)|convert \d|how many (days|hours))\b/i, 2, 'lookup'),
      r(/\b(log (this|it)|update the work ?log|add (this|it) to (notion|the calendar))\b/i, 2, 'logging'),
      r(/\b(morning (check|scan)|eod|end of day|what('?s| is) next|catch me up)\b/i, 1, 'status brief'),
    ],
  },

  // Everyday work: writing, messages, plans, briefs, small scripts.
  standard: {
    name: 'standard',
    label: 'Standard',
    model: 'sonnet',
    effort: 'medium',
    rules: [
      r(/\b(email|e-mail|message|reply|dm|feishu|whatsapp|slack|text (him|her|them))\b/i, 2, 'message'),
      r(/\b(draft|write|rewrite|ghostwrite|in my voice|caption|copy)\b/i, 1, 'writing'),
      r(/\b(script|shot ?list|brief|outline|treatment|wardrobe|call ?sheet|lighting (chart|plan))\b/i, 2, 'production doc'),
      r(/\b(summari[sz]e|recap|meeting notes|action items|checklist|kpi|sop)\b/i, 2, 'summary'),
      r(/\b(research|compare|look up|find out|explain|what does .* mean)\b/i, 1, 'research'),
      r(/\b(notion|calendar|schedule|sync|triage|deliverables?)\b/i, 1, 'workspace'),
      r(/\b(spreadsheet|xlsx|csv|sheet|table)\b/i, 1, 'data'),
    ],
  },

  // Web development: the Trivux theme, the PRO app, anything with code.
  build: {
    name: 'build',
    label: 'Build',
    model: 'opus',
    effort: 'high',
    rules: [
      r(/\b(website|web ?site|wordpress|wp-admin|theme|trivux ?pro|members app|workout app)\b/i, 3, 'web dev'),
      r(/\b(php|css|scss|html|javascript|typescript|tsx?|jsx|react|node|python|sql|json|yaml)\b/i, 2, 'code'),
      r(/\b(bug|debug|error|exception|stack ?trace|crash|broken|not working|fails?|failing)\b/i, 2, 'debugging'),
      r(/\b(refactor|component|endpoint|api|database|schema|migration|webhook|integration)\b/i, 2, 'engineering'),
      r(/\b(deploy|push (it )?live|changelog|version bump|package the theme|commit|pull request|pr\b|repo)\b/i, 2, 'shipping'),
      r(/\b(build|implement|code|function|feature|page template|plugin|mod|hook)\b/i, 1, 'building'),
      r(/\b(scheduler|booking|roster|pin gate|checkout|stripe|square)\b/i, 2, 'app logic'),
    ],
  },

  // Graphic design: brand assets, layouts, flyers, carousels, storyboards.
  design: {
    name: 'design',
    label: 'Design',
    model: 'fable',
    effort: 'high',
    rules: [
      r(/\b(graphic|flyer|poster|carousel|banner|thumbnail|story graphic|instagram post|ig post)\b/i, 3, 'graphic'),
      r(/\b(layout|typography|type ?face|font pairing|colou?r palette|grid|composition)\b/i, 2, 'layout'),
      r(/\b(brand (kit|system|assets?|guide)|logo|mood ?board|art direction|visual identity)\b/i, 3, 'brand'),
      r(/\b(design|redesign|mockup|mock-up|visual|aesthetic)\b/i, 1, 'design'),
      r(/\b(storyboard|character sheet|frame (design|comp)|key ?visual)\b/i, 2, 'storyboard'),
      r(/\b(pricing (flyer|sheet)|pdf (design|asset)|deck design|slide design)\b/i, 3, 'collateral'),
    ],
  },

  // Higgsfield generation: Seedance, Genjutsu, motion control, AI video.
  video: {
    name: 'video',
    label: 'Video',
    model: 'opus',
    effort: 'xhigh',
    rules: [
      r(/\b(higgsfield|seedance|genjutsu|kling|veo|sora|hailuo|wan ?2)\b/i, 4, 'Higgsfield model'),
      r(/\b(motion (control|transfer)|replace (the )?object|image[- ]to[- ]video|text[- ]to[- ]video|i2v|t2v)\b/i, 3, 'video gen'),
      r(/\b(generate|make|render|create) (an? |the |some )?(ai )?(video|clip|reel|b-?roll|hero (shot|video)|ad creative)\b/i, 3, 'video gen'),
      r(/\b(ai influencer|face ?swap|lip ?sync|dubbing|upscale (the )?video|video (edit|extension))\b/i, 3, 'video edit'),
      r(/\b(hero shot|lifestyle shot|product video|b-?roll)\b/i, 2, 'asset'),
    ],
  },
}

// A short reply that continues the previous task keeps the previous route.
export const FOLLOW_UP =
  /^(y(es|ep|eah)?|ok(ay)?|sure|go( ahead)?|do it|continue|proceed|looks good|lgtm|perfect|great|thanks?( you)?|ship it|next|try again|retry|again|keep going|yes please|approved?|that works|sounds good)\b/i

// Words that ask for more (or less) thinking; they move effort, never the model.
export const EFFORT_UP =
  /\b(from scratch|entire|whole (site|app|thing)|architecture|end[- ]to[- ]end|complex|carefully|think (hard|deeply)|thoroughly|ultrathink|production[- ]ready|overhaul)\b/i
export const EFFORT_DOWN = /\b(quick(ly)?|just|simple|small|tiny|one[- ]line|minor|real quick)\b/i
