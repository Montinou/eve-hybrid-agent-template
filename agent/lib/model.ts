// Single source of truth for the loop's model ids. agent/agent.ts imports
// both constants for its defineDynamic routing, so the model that actually
// runs and any place that logs/reports a model id can never drift apart.
// Keep EVERY model id in this module — never inline a model string elsewhere.
//
// Gateway id convention is dot-notation for the version (e.g.
// `anthropic/claude-haiku-4.5`, `anthropic/claude-opus-4.8` in the eve docs).
// Note this differs from the Anthropic-native hyphenated format the nested
// dev-agent uses (`claude-sonnet-4-5` via DEV_AGENT_MODEL, resolved in
// lib/dev-agent.ts) — the two layers speak different id dialects.
//
// Both ids are env-overridable so a model migration is an env change, not a
// code change, and rollback is just unsetting the env var. Only the compiled
// fallback below is validated at build time — a bad env override fails at
// request time, on the turns that use it, never at deploy time.

// Default loop model: handles routing, ordinary turns, and result formatting.
// The cheapest capable Gateway model is the right choice here — the
// intelligence lives in the nested dev-agent, not in the loop.
// CUSTOMIZE: pick your default loop model (docs/04-orchestrator.md). If this
// model's output feeds an accuracy/telemetry dataset, keep it PINNED so the
// series stays comparable, and log the id with every decision row.
export const orchestratorModelId =
  process.env.ORCHESTRATOR_MODEL ?? "google/gemini-2.5-flash-lite";

// Model for command turns (a bot-mention command on a PR), selected per-turn
// by agent/agent.ts's defineDynamic when the session auth carries a
// `command` attribute (set by the channel dispatch — see
// agent/lib/dispatch.ts). A mid-tier model is enough: the orchestrator
// only maps commands to tools and formats their structured results.
// Non-command turns keep `orchestratorModelId` untouched — this constant
// never affects the default path.
// CUSTOMIZE: pick your command-turn model (docs/04-orchestrator.md).
export const commandModelId =
  process.env.COMMAND_MODEL ?? "anthropic/claude-haiku-4.5";
