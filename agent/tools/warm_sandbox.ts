import { defineTool } from "eve/tools";
import { z } from "zod";
import { warmSandboxTemplate } from "#lib/dev-agent.ts";
import { warmEveSandboxTemplate } from "#lib/eve-sandbox.ts";

// Keeps BOTH sandbox lifecycles alive. They are independent, fail
// independently, and only one of them is obvious:
//
//   1. The dev-agent's HARNESS template. Builds/refreshes its snapshot OUT of
//      the request path (a fresh template — Claude Code install + estate clones +
// deps install — takes several minutes, most of a workflow step's ~800s
// budget). Run once after any deploy that changes the sandbox recipe
// (RECIPE_VERSION / the enabled repo+branch set), or before a batch of runs
// if the last deploy was recent. Idempotent: when the template is already
// current the provider snapshot is reused and this returns quickly.
// Also sweeps orphaned template sandboxes/snapshots left behind by a prior
// recipe version — see agent/lib/template-sweep.ts.
//
//   2. EVE'S OWN template — the sandbox behind the GitHub-channel checkout
//      that read_file/grep/glob need. eve provisions it ONLY during a build,
//      its snapshot expires on a timer, and eve's own repair path is disabled
//      outside local development: once that snapshot lapses, NOTHING brings it
//      back and every later turn runs without a checkout until someone
//      redeploys. See agent/lib/eve-sandbox.ts and docs/06-sandbox-lifecycle.md.
//
// This tool is invoked daily by agent/schedules/template-maintenance.md so
// neither snapshot ages into its expiration, and the sweeps run even on days
// with zero traffic. Both halves are fail-soft and reported separately, so a
// dead lifecycle can never hide behind a healthy one.
export default defineTool({
  description:
    "Warm the dev-agent sandbox template (Claude Code install + estate " +
    "clones + dependency install, snapshot-cached). Prepares/refreshes the " +
    "template out-of-band; idempotent and safe to run anytime — near-instant " +
    "when already warm, several minutes on a cold template. Call once after " +
    "deploys that change the sandbox recipe, or before a batch of runs. " +
    "Also renews eve's own sandbox template and sweeps orphaned " +
    "prior-recipe templates and dead session records. Pass deep:true on a " +
    "weekly pass to additionally sweep prior-identity eve templates.",
  inputSchema: z.object({
    deep: z
      .boolean()
      .optional()
      .describe(
        "Weekly deep pass: additionally sweep prior-identity eve templates " +
          "and their snapshots. Defaults to false (daily pass).",
      ),
  }),
  async execute({ deep }, ctx) {
    const startedAt = Date.now();
    const { ready, detail } = await warmSandboxTemplate(ctx.abortSignal);

    // Never let a harness-side failure skip eve's renewal: the two templates
    // are unrelated, and the eve one is the cheaper and more fragile.
    const eve = await warmEveSandboxTemplate({
      ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
      ...(deep === undefined ? {} : { deep }),
    });

    return {
      warmed: ready,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      detail,
      eve: {
        healthy: eve.healthy,
        action: eve.action,
        reason: eve.reason,
        template: eve.template,
        ...(eve.rebuildTriggered === undefined
          ? {}
          : { rebuildTriggered: eve.rebuildTriggered }),
        deletedTemplates: eve.deletedTemplates.length,
        deletedSessions: eve.deletedSessions.length,
        deletedSnapshots: eve.deletedSnapshots,
        ...(eve.errors.length ? { errors: eve.errors } : {}),
      },
    };
  },
});
