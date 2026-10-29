import { defineEval } from "eve/evals";
import { BOT_NAME } from "#lib/dispatch.ts";

// Delegation: a heavy task goes to the run_dev_task capability tool exactly
// once, and the tool's result reaches the user. The tool is STUBBED (eve tool
// stubs, node_modules/eve/docs/evals/tool-stubs.mdx), so no sandboxed dev-agent
// boots — the eval costs one orchestrator turn, nothing more. The stub response
// uses run_dev_task's real output shape (DevAgentResult plus the `capability`
// tag, agent/tools/run_dev_task.ts).
//
// Tool replacement is denied by default: the target's eve channel must permit
// it for the eval runner (allowToolStubs; see the tool-stubs doc and
// docs/08-extensions.md). Keep the stub shape in sync with run_dev_task.
export default defineEval({
  description:
    "GATE: a heavy task is delegated to run_dev_task once and its result is relayed",
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
    const turn = await session.send(`@${BOT_NAME} run`);
    turn.succeeded().gate();
    turn.calledTool("run_dev_task", { count: 1 }).gate();
    turn.messageIncludes("stubbed-result");
  },
});
