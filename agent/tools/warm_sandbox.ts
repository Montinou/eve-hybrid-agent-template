import { defineTool } from "eve/tools";
import { z } from "zod";
import { warmSandboxTemplate } from "#lib/dev-agent.ts";

// Builds/refreshes the dev-agent sandbox template snapshot OUT of the
// request path (a fresh template — Claude Code install + estate clones +
// deps install — takes several minutes, most of a workflow step's ~800s
// budget). Run once after any deploy that changes the sandbox recipe
// (RECIPE_VERSION / the enabled repo+branch set), or before a batch of runs
// if the last deploy was recent. Idempotent: when the template is already
// current the provider snapshot is reused and this returns quickly.
// Also sweeps orphaned template sandboxes/snapshots left behind by a prior
// recipe version — see agent/lib/template-sweep.ts.
//
// This tool is also invoked daily by agent/schedules/template-maintenance.md
// so the template's snapshot never ages into its 7-day expiration (which
// would force the next run to pay a cold rebuild) and the sweeps run even on
// days with zero traffic.
export default defineTool({
  description:
    "Warm the dev-agent sandbox template (Claude Code install + estate " +
    "clones + dependency install, snapshot-cached). Prepares/refreshes the " +
    "template out-of-band; idempotent and safe to run anytime — near-instant " +
    "when already warm, several minutes on a cold template. Call once after " +
    "deploys that change the sandbox recipe, or before a batch of runs. " +
    "Also sweeps any orphaned prior-recipe template sandbox/snapshots.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const startedAt = Date.now();
    const { ready, detail } = await warmSandboxTemplate(ctx.abortSignal);
    return {
      warmed: ready,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      detail,
    };
  },
});
