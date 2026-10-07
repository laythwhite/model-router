# Model Router

A Claude Code mod that classifies every prompt you send and runs that turn on the cheapest model and effort level that can do it well. No `/model` switching by hand.

## Tiers

| Tier | Model | Effort | Typical asks |
| --- | --- | --- | --- |
| Quick | Haiku | low | mileage, attendance, typos, lookups, logging |
| Standard | Sonnet | medium | Feishu/email drafts, scripts, briefs, summaries, research |
| Build | Opus | high | Trivux theme, PRO app, PHP/CSS/JS, bugs, deploys |
| Design | Fable (configurable) | high | flyers, carousels, brand kits, layouts, storyboards |
| Video | Opus (configurable) | xhigh | Higgsfield, Seedance, Genjutsu, motion control |

Video renders on Higgsfield's side either way. The Claude model only writes the prompt and drives the tools, which is why the default is Opus at extra-high effort instead of Fable. Switch it in `/config` if Fable writes better prompts for you.

## How it decides

1. **Keyword rules** (`hooks/routes.ts`) score the prompt for each tier. No tokens spent.
2. **Haiku tiebreak**: when two tiers are close, Haiku gets one 8-token call to pick a label. Turn it off in `/config`.
3. **Follow-ups** like "yes", "go ahead" or "try again" keep the previous route.
4. **Effort nudges**: "from scratch", "entire" or "thoroughly" raise effort one step, and "quick", "just" or "small" lower it. The model stays the same.
5. **Cache guard**: once a conversation is past 30k tokens, the router won't drop to a cheaper model mid-session. A switch re-bills the whole context, so it usually costs more than it saves. Moving *up* is always allowed. On a very large context it suggests `/clear` instead.
6. **Locked per turn**: the model is chosen at the start of a turn and stays for every request in that turn.
7. **Subagents** keep whatever model their own definition names.

## Using it

The status line shows the route for each prompt, e.g. `⇢ Opus · high · Build`.

**One-off override**: start the prompt with a tag. The tag is removed before Claude reads the prompt.

```
[fable max] redo the pricing flyer
[sonnet low] what's on my list today?
[design] make the hero section feel premium
```

**`/route` command**

```
/route                 status: last route, why, context size
/route auto            route every prompt (default)
/route suggest         only show the route, don't switch models
/route off             router off
/route pin opus        every prompt on Opus until unpinned
/route pin design max  every prompt on the Design tier at max effort
/route unpin
/route stats           turns and tokens per model since install
/route reset [stats]   clear pin / unavailable list (and stats)
```

## Settings (`/config` → model-router)

- Routing mode: auto, suggest or off
- Tiebreaker: haiku or off
- Design tier model: fable, opus or sonnet
- Video tier model: opus, fable or sonnet
- Cache guard tokens: default 30000; 0 turns it off

## Customizing

Edit `hooks/routes.ts`: tier models, efforts and keyword patterns all live there. Model IDs sit at the top in `MODEL_IDS`. Update them when a new generation ships.

## What it can't do

- It can't measure savings for you in dollars. `/route stats` shows real per-model token counts, and you compare against your usage page.
- If the account can't use a routed model, the router falls back to the session model for that turn and skips the routed model for the rest of the session.
- Routing is keyword-based. If a prompt lands in the wrong tier, use a tag, or add the word to `routes.ts`.

## Development

```
claude plugin validate .
claude plugin test .
```
