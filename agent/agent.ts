import { defineAgent, defineDynamic } from "eve";
import { commandModelId, orchestratorModelId } from "#lib/model.ts";

export default defineAgent({
  // Per-turn dynamic model (see node_modules/eve/docs/agent-config.md,
  // §"Choose the model dynamically", and
  // node_modules/eve/docs/guides/dynamic-capabilities.md).
  //
  // The function MUST return a concrete model on every evaluation. A missing
  // or invalid selection (including null) fails the turn before any
  // model-dependent work begins, so name the default explicitly.
  //
  // eve evaluates a dynamic model before EVERY ordinary model call, not once
  // per event. The decision is therefore memoized on `ctx.turn?.id ?? null`:
  // that keeps one choice for the whole turn (the per-turn scope this agent
  // needs) and re-runs the resolver when the next turn starts. Do NOT key the
  // memo on `ctx.session.id` (once per session): one durable session can mix
  // turn kinds — PR-event turns and PR-comment turns of the same PR share
  // one continuation session (agent/channels/github.ts) — so whichever turn
  // created the session would otherwise pin its model for every later turn
  // of that session, regardless of kind. `ctx.session.auth.current` reflects
  // the CURRENT turn's auth (a follow-up message updates `auth.current`).
  //
  // (A session-keyed memo is preferred only when a session's model never
  // needs to change turn-to-turn, since prompt caches are per model and a
  // switch re-ingests the conversation at uncached prices — mixed-turn
  // sessions like this one need the per-turn scope instead.)
  //
  // The routing SIGNAL comes from the channel, not from model judgment: the
  // dispatch handler in agent/channels/github.ts sets the `command`
  // attribute on the turn's SessionAuthContext when a bot-mention command
  // dispatches a command turn, and this resolver just reads it back.
  // Deterministic code decides; the model executes.
  model: defineDynamic((ctx) =>
    // CUSTOMIZE: `command` must match the attribute name your dispatch
    // handler sets in agent/lib/dispatch.ts (docs/04-orchestrator.md).
    // Add more attribute checks here if you introduce additional turn
    // kinds at different price points — every branch must return a model.
    // The memo result must be JSON, so it stores the model ID string.
    ctx.memo(ctx.turn?.id ?? null, () =>
      typeof ctx.session.auth.current?.attributes.command === "string"
        ? commandModelId
        : orchestratorModelId,
    ),
  ),
  // CUSTOMIZE: add `outputSchema` (a zod schema) if your agent has task-mode
  // runs (schedules, subagents, remote jobs) that must return structured
  // output. Interactive turns ignore it unless the client supplies a
  // per-message schema. See node_modules/eve/docs/agent-config.md.
});
