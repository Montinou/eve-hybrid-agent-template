import { ESTATE_ROOT, type EstateRepo } from "./estate.ts";

// Pure assembly of the run_dev_task capability prompt handed to
// `runDevAgent({ prompt })`. Kept as a standalone, side-effect-free module
// so it can be unit-tested without touching the sandbox stack, and so the
// tool wrapper (agent/tools/run_dev_task.ts) stays a thin extraction layer.
//
// SECRETS RULE (non-negotiable): nothing that flows into this builder may be
// a secret value. Per-run secrets travel exclusively through
// `runDevAgent({ sessionSecrets })` → the sandbox env → a chmod-600 tmp file
// — this builder may reference that file's PATH (`secretsPath`) so the
// dev-agent knows where to read credentials, but never a value.
//
// HOST-SIDE CONTEXT RESOLUTION: the sandbox deliberately has no third-party
// API access and no host secrets. Anything the dev-agent needs from the
// outside world (ticket-system context, preview deployment URLs, catalog
// data, ...) must be resolved by the TOOL on the host and embedded here as
// plain content via `extraContext`. Resolve it fail-soft: the capability
// must run identically when the extra context is unavailable.

/**
 * Deterministic, channel-derived context for a task run. Populated from
 * `ctx.session.auth.current` attributes by the tool wrapper (never from
 * model-generated text when channel context exists).
 */
export interface TaskContext {
  /** Repository full name, e.g. "your-github-org/example-app". */
  repository: string;
  /** Head branch to check out on the target repo. */
  branch: string;
  /** PR number when the turn originated from a pull request; 0/absent otherwise. */
  pr_number?: number;
  /** PR/comment author login when known. */
  author?: string;
}

export function buildTaskPrompt(params: {
  /** What the dev-agent should do, in plain language. */
  task: string;
  context: TaskContext;
  /**
   * The resolved EstateRepo for the context's repository (via
   * findEstateRepo), or `undefined` when the repo isn't in the estate at all
   * — this function still produces a usable prompt in that case (the caller,
   * runDevAgent, is what actually fails soft on an unknown/disabled repo).
   */
  target: EstateRepo | undefined;
  /**
   * Optional host-resolved context (ticket details, preview URL, domain
   * skill content, ...) embedded verbatim as its own section.
   * CUSTOMIZE: this is where domain capabilities inject their procedure —
   * see docs/05-dev-agent.md for real-world examples (embedding a review
   * skill, a per-repo SDLC guide, linked-ticket context).
   */
  extraContext?: string;
  /**
   * Absolute in-sandbox path of the per-run secrets file (pass
   * SESSION_SECRETS_PATH from dev-agent.ts) — ONLY when sessionSecrets were
   * actually provisioned for this run. The path is not a secret; the values
   * behind it never appear in any prompt.
   */
  secretsPath?: string;
}): string {
  const { task, context, target, extraContext, secretsPath } = params;

  const estatePath = target
    ? `${ESTATE_ROOT}/${target.dir}`
    : `${ESTATE_ROOT}/<unresolved repo: ${context.repository}>`;

  const sections = [
    `# Dev task capability`,
    ``,
    `## Task`,
    ``,
    task,
    ``,
    `## Context`,
    ``,
    `- Repository: ${context.repository}`,
    `- Branch: ${context.branch || "unknown"}`,
    ...(context.pr_number ? [`- PR number: #${context.pr_number}`] : []),
    ...(context.author ? [`- Author: ${context.author}`] : []),
    `- Estate checkout path: ${estatePath}`,
  ];

  if (secretsPath) {
    sections.push(
      ``,
      `## Credentials`,
      ``,
      `Per-run credentials for this task are in the JSON file at ` +
        `\`${secretsPath}\` (chmod 600). Read them from there when needed. ` +
        `Never print, log, or include their values in your report.`,
    );
  }

  if (extraContext) {
    sections.push(``, `## Additional context (host-resolved)`, ``, extraContext);
  }

  return sections.join("\n");
}
