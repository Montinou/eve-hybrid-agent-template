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
// Cost note: the command case STUBS run_dev_task (eve tool stubs,
// node_modules/eve/docs/evals/tool-stubs.mdx), so it boots no sandboxed
// dev-agent: the stub removes that cost and each case costs one orchestrator
// turn (the greeting case expects no tool call at all). Tool replacement is
// denied by default: the target's eve channel must permit it for the eval
// runner (allowToolStubs; docs/10-evals.md), and agent/channels/eve.ts does
// not. Both cases are tagged `fast`; `live` is reserved for evals that
// exercise the real tool, and `pnpm eval` excludes it.
// ---------------------------------------------------------------------------

export default [
  defineEval({
    description:
      "GATE: a mention command routes to the run_dev_task capability tool.",
    tags: ["fast"],
    async test(t) {
      const session = await t.session({
        stubs: [
          {
            id: "dev",
            tool: "run_dev_task",
            outcome: {
              response: {
                status: "ok",
                summary: "stubbed-result",
                capability: "task",
              },
            },
          },
        ],
      });
      // CUSTOMIZE: keep this message in sync with your command grammar
      // (agent/lib/dispatch.ts) and command→tool table (agent/instructions.md).
      const turn = await session.send(`@${BOT_NAME} run`);
      // Scoped (turn, session and run) assertions gate by default; .gate()
      // makes it explicit.
      turn.succeeded().gate();
      turn.calledTool("run_dev_task").gate();
    },
  }),
  defineEval({
    description:
      "GATE: a plain greeting must NOT trigger the expensive dev-agent capability.",
    tags: ["fast"],
    async test(t) {
      await t.send("Hello!");
      t.succeeded().gate();
      t.notCalledTool("run_dev_task").gate();
    },
  }),
];
