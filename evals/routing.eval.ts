import { defineEval } from "eve/evals";
import { BOT_NAME } from "#lib/dispatch.ts";

// ---------------------------------------------------------------------------
// What these evals cover — and what they deliberately do NOT (verified against
// the bundled eve docs, node_modules/eve/docs/evals/).
//
// eve evals drive the agent over the client-session HTTP surface (`t.send`),
// which renders the message as the user turn against the LIVE agent model
// (evals/running.mdx: "Evals run against a live model, so the CI environment
// must provide the model-provider credentials"). Two consequences shape these
// cases:
//
//  1. `SendTurnPayload` has NO `auth` field, so an eval cannot set the
//     `command` SESSION-AUTH attribute the way agent/lib/dispatch.ts's
//     onCommentDispatch does. That attribute drives the per-turn dynamic model
//     (agent/agent.ts) and is readable by tools — NOT the model's routing.
//     What the model actually routes on is the comment TEXT: a real mention
//     command reaches the model as the user message, so sending that same text
//     exercises the same instruction routing (agent/instructions.md §Command
//     turns) the channel would trigger. These evals therefore assert the
//     model-visible routing, not the channel's auth plumbing.
//
//  2. `mockModel` (eve/evals) is agent-DEFINITION scoped (agent.ts `model`),
//     not per-eval. Wiring it in would pull a fixture model into the
//     production agent definition, so these run against the live agent model
//     rather than a mock.
//
// The channel's deterministic pieces (the command parser, the estate-enabled
// gates, the attribute projection) are covered offline, without a model, in
// agent/lib/dispatch.test.ts — keep behavior there whenever possible; evals
// are for what only the live loop can prove.
//
// Cost note: the first case really calls the run_dev_task tool on the target
// agent. The tool is never-throw — with the dev-agent unconfigured it returns
// a structured `failed` result, so `calledTool` still gates correctly — but
// against a fully configured deployment it boots a real sandboxed dev-agent
// run. Run `eve eval` deliberately, not on every push.
// ---------------------------------------------------------------------------

export default [
  defineEval({
    description:
      "GATE: a mention command routes to the run_dev_task capability tool.",
    async test(t) {
      // CUSTOMIZE: keep this message in sync with your command grammar
      // (agent/lib/dispatch.ts) and command→tool table (agent/instructions.md).
      await t.send(`@${BOT_NAME} run`);
      // Run-level assertions gate by default; .gate() makes it explicit.
      t.succeeded().gate();
      t.calledTool("run_dev_task").gate();
    },
  }),
  defineEval({
    description:
      "GATE: a plain greeting must NOT trigger the expensive dev-agent capability.",
    async test(t) {
      await t.send("Hello!");
      t.succeeded().gate();
      t.notCalledTool("run_dev_task").gate();
    },
  }),
];
