import { defineTool } from "eve/tools";
import { z } from "zod";
import { buildTaskPrompt, type TaskContext } from "#lib/build-task-prompt.ts";
import {
  parseDevTaskSecrets,
  redactSecrets,
  runDevAgent,
  SESSION_SECRETS_PATH,
  type DevAgentResult,
} from "#lib/dev-agent.ts";
import { findEstateRepo } from "#lib/estate.ts";

// The single generic capability tool: run the nested Claude Code dev-agent
// against a repo of the estate. This is the file you CLONE to create
// domain-specific capabilities (a review tool, a verify tool, ...) — each
// clone gets its own mode (extend DevAgentMode in lib/dev-agent.ts), its own
// prompt builder, and its own model-facing input schema, while the whole
// sandbox/budget/secrets machinery stays in lib/dev-agent.ts.
//
// Everything here is a THIN wrapper by design: extract deterministic
// context, build the prompt HOST-SIDE, delegate, tag the result. No sandbox
// or model logic belongs in a tool file.

const CAPABILITY = "task" as const;

/** Tags every return path with which capability produced it, so the
 * orchestrator can label report sections when several capabilities run. */
function withCapability(
  result: DevAgentResult,
): DevAgentResult & { capability: typeof CAPABILITY } {
  return { ...result, capability: CAPABILITY };
}

/** Safe string read of a session-auth attribute ("" when absent). */
function readAttribute(
  attributes: Readonly<Record<string, string | readonly string[]>> | undefined,
  key: string,
): string {
  const value = attributes?.[key];
  return typeof value === "string" ? value : "";
}

export default defineTool({
  description:
    "Run a development task inside a sandboxed Claude Code dev-agent with " +
    "the repo estate cloned to its filesystem (read-only analysis: it reads " +
    "code, greps, traces — it never commits or pushes). Returns a " +
    "structured markdown result. Never throws; on budget exhaustion or an " +
    "unresolvable repo/branch it returns a fail-soft result with " +
    "diagnostics.",
  inputSchema: z.object({
    task: z
      .string()
      .min(1)
      .describe(
        "What the dev-agent should do, in plain language (it has the full " +
          "repo checkout to work with).",
      ),
    // repo/branch are FALLBACKS for turns with no channel context (e.g. a
    // direct chat message during `eve dev`). When the turn came from a
    // GitHub webhook, the channel-dispatched session attributes win — those
    // are deterministic runtime data, not model-generated text.
    repo: z
      .string()
      .optional()
      .describe(
        "Repository full name; only needed when the session has no channel " +
          "context (falls back to session attributes otherwise).",
      ),
    branch: z
      .string()
      .optional()
      .describe(
        "Branch to check out on the target repo; only needed when the " +
          "session has no channel context.",
      ),
  }),
  async execute({ task, repo, branch }, ctx) {
    // Deterministic context first: the GitHub channel's dispatch populates
    // these attributes at webhook time (see agent/channels/github.ts). Model
    // input is only consulted when the attribute is absent.
    const attributes = ctx.session.auth.current?.attributes;
    const repository = readAttribute(attributes, "repository") || repo?.trim() || "";
    const headBranch = readAttribute(attributes, "branch") || branch?.trim() || "";
    const prNumber = Number.parseInt(
      readAttribute(attributes, "pull_request_number"),
      10,
    );
    const author =
      readAttribute(attributes, "pr_author") ||
      readAttribute(attributes, "user_login");

    if (!repository || !headBranch) {
      return withCapability({
        status: "failed",
        summary:
          "No target repo/branch available — the session has no channel " +
          "context and none were provided as input. On PR turns the GitHub " +
          "channel attaches these automatically.",
        diagnostics: `repository="${repository}" branch="${headBranch}"`,
      });
    }

    const context: TaskContext = {
      repository,
      branch: headBranch,
      ...(Number.isFinite(prNumber) && prNumber > 0 ? { pr_number: prNumber } : {}),
      ...(author ? { author } : {}),
    };

    // Optional per-run secrets: a HOST env var (DEV_TASK_SECRETS_JSON, a
    // JSON string→string map) parsed fail-soft. Values flow only through
    // sessionSecrets → the sandbox env → SESSION_SECRETS_PATH; the prompt
    // gets the PATH, never a value.
    const sessionSecrets = parseDevTaskSecrets(process.env.DEV_TASK_SECRETS_JSON);

    try {
      const target = findEstateRepo(repository);
      return withCapability(
        await runDevAgent({
          mode: "task",
          repo: repository,
          branch: headBranch,
          prompt: buildTaskPrompt({
            task,
            context,
            target,
            // CUSTOMIZE: resolve domain context host-side and pass it as
            // `extraContext` here (linked tickets, preview URLs, domain
            // skills). Keep it fail-soft: the run must work without it.
            ...(sessionSecrets ? { secretsPath: SESSION_SECRETS_PATH } : {}),
          }),
          ...(sessionSecrets ? { sessionSecrets } : {}),
        }),
      );
    } catch (err) {
      // runDevAgent never throws by contract; this is defense-in-depth for
      // anything above it (prompt building, attribute extraction).
      return withCapability({
        status: "failed",
        summary: "run_dev_task crashed before producing a report.",
        diagnostics: redactSecrets(
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        ),
      });
    }
  },
});
