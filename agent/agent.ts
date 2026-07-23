import { defineAgent, defineDynamic } from "eve";
import { commandModelId, orchestratorModelId } from "#lib/model.ts";

export default defineAgent({
  // Per-turn dynamic model (see node_modules/eve/docs/agent-config.md,
  // §"Choose the model dynamically"): `fallback` is the compiled static model
  // and anchors build-time metadata (routing, credentials, context window).
  //
  // The resolver is keyed on `turn.started` (once per turn) — NOT
  // `session.started` (once per session) — because one durable session can
  // mix turn kinds: PR-event turns and PR-comment turns of the same PR share
  // one continuation session (agent/channels/github.ts), so whichever event
  // created the session would otherwise pin its model for every later turn
  // of that session, regardless of kind. `turn.started` re-runs the resolver
  // on every turn, and `ctx.session.auth.current` reflects the CURRENT
  // turn's auth (a follow-up message updates `auth.current`).
  //
  // (`session.started` is preferred only when a session's model never needs
  // to change turn-to-turn, since prompt caches are per model and a switch
  // re-ingests the conversation at uncached prices — mixed-turn sessions
  // like this one need the per-turn scope instead.)
  //
  // The routing SIGNAL comes from the channel, not from model judgment: the
  // dispatch handler in agent/channels/github.ts sets the `command`
  // attribute on the turn's SessionAuthContext when a bot-mention command
  // dispatches a command turn, and this resolver just reads it back.
  // Deterministic code decides; the model executes.
  model: defineDynamic({
    fallback: orchestratorModelId,
    events: {
      // CUSTOMIZE: `command` must match the attribute name your dispatch
      // handler sets in agent/lib/dispatch.ts (docs/04-orchestrator.md).
      // Add more attribute checks here if you introduce additional turn
      // kinds at different price points. Returning null → fallback.
      "turn.started": (_event, ctx) =>
        typeof ctx.session.auth.current?.attributes.command === "string"
          ? commandModelId
          : null,
    },
  }),
  // CUSTOMIZE: add `outputSchema` (a zod schema) if your agent has task-mode
  // runs (schedules, subagents, remote jobs) that must return structured
  // output. Interactive turns ignore it unless the client supplies a
  // per-message schema. See node_modules/eve/docs/agent-config.md.
});
