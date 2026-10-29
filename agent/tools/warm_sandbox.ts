import { defineTool } from "eve/tools";
import { z } from "zod";
import { warmSandboxTemplate } from "#lib/dev-agent.ts";

// Warms the dev-agent's HARNESS template out of the request path (a fresh
// template — Claude Code install + estate clones + deps install — takes
// several minutes, most of a workflow step's ~800s budget). Run once after
// any deploy that changes the sandbox recipe (RECIPE_VERSION / the enabled
// repo+branch set), or before a batch of runs if the last deploy was recent.
// Idempotent: when the template is already current its snapshot is reused
// and this returns quickly. Also sweeps orphaned template sandboxes and
// snapshots left behind by a prior recipe version — see
// agent/lib/template-sweep.ts.
//
// eve's OWN sandbox template is not this tool's business. `eve build` records
// it as a snapshot in the build artifact and the runtime creates session
// sandboxes from that snapshot ID
// (node_modules/eve/docs/sandbox/vercel.mdx §Snapshot preparation); "The
// runtime never recreates a template. Run `eve build` again and deploy its
// output" (sandbox/troubleshooting.mdx). So the repair for a lapsed eve
// template is a redeploy, done by a person — never a hook fired from a
// routine warm. See docs/06-sandbox-lifecycle.md.
//
// Invoked daily by agent/schedules/template-maintenance.md so the harness
// template snapshot never ages into its expiration and the sweeps run even
// on days with zero traffic.
export default defineTool({
  description:
    "Warm the dev-agent sandbox template (Claude Code install + estate " +
    "clones + dependency install, snapshot-cached). Prepares/refreshes the " +
    "template out-of-band; idempotent and safe to run anytime — fast when " +
    "already warm, several minutes on a cold template. Call once after " +
    "deploys that change the sandbox recipe, or before a batch of runs. " +
    "Also sweeps orphaned prior-recipe templates.",
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
