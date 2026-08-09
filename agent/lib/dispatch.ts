// Deterministic dispatch for the GitHub channel.
//
// The template's rule: EVERYTHING gate-able is gated here, in code, before any
// model runs. Inbound webhook hooks return `{ auth }` to start a turn or `null`
// to ignore the event (node_modules/eve/docs/channels/github.mdx §Dispatch).
// The two handlers — onPullRequestDispatch and onCommentDispatch — are exported
// (mostly) pure functions so they unit-test without webhooks (dispatch.test.ts);
// agent/channels/github.ts only wires them into githubChannel.
//
// Why deterministic? Cost and auditability. The cheap loop model never sees
// events that don't matter, a dispatch bug is a failing unit test instead of a
// "the model felt like it" mystery, and the security boundary starts here:
// only events matching an explicit code path get any further.
//
// The attributes bridge (docs/03-github-channel.md §3): tools see NOTHING
// channel-specific — no ctx.github, no webhook payload. The ONLY deterministic
// way for a tool to receive PR data is the SessionAuthContext.attributes map
// attached here at dispatch time, read back inside tools via
// `ctx.session.auth.current.attributes`. So this module projects every piece
// of context tools will later need. If a new capability needs another piece of
// webhook context, the change starts HERE, not in the tool.

import type {
  GitHubComment,
  GitHubInboundContext,
  GitHubInboundResult,
  GitHubPullRequestEvent,
} from "eve/channels/github";
import { defaultGitHubAuth } from "eve/channels/github";
import type { SessionAuthContext } from "eve/context";
import type { EstateRepo } from "./estate.ts";
import { findEstateRepo } from "./estate.ts";

// ---------------------------------------------------------------------------
// Bot identity
// ---------------------------------------------------------------------------

// CUSTOMIZE: the bot's mention handle — set this to YOUR GitHub App's name
// (docs/01-prerequisites.md decides it; docs/03-github-channel.md wires it).
// It drives BOTH eve's mention dispatch (githubChannel's `botName` in
// agent/channels/github.ts imports this constant) and parseCommand's mention
// check below. `GITHUB_APP_SLUG` is eve's own env fallback for botName
// (channels/github.mdx), honored here so the two mention checks can never
// disagree; the literal is the default when the env is unset.
export const BOT_NAME = process.env.GITHUB_APP_SLUG?.trim() || "my-dev-agent";

// ---------------------------------------------------------------------------
// Command parsing (pure — no eve types involved)
// ---------------------------------------------------------------------------

// CUSTOMIZE: the explicit command prefix and the known bare commands. The
// template ships one capability (`run` → the run_dev_task tool). When you add
// a capability, add its command word here AND extend the command→tool table in
// agent/instructions.md in the same change (docs/04-orchestrator.md).
export const COMMAND_PREFIX = "/task";
export const KNOWN_COMMANDS: readonly string[] = ["run"];
export const DEFAULT_COMMAND = "run";

/**
 * Extract the command from a comment body, or null when the comment is not a
 * command for this bot.
 *
 * Grammar (two accepted forms, both requiring an `@botName` mention):
 *
 *  1. Bare form — `@bot run`: the first token after the mention must be a
 *     KNOWN command. Unknown tokens return null, so prose that merely mentions
 *     the bot ("thanks @bot!") does NOT create a session.
 *  2. Explicit form — `@bot /task <anything>`: the COMMAND_PREFIX token marks
 *     an unambiguous invocation, so ANY subcommand token is accepted and
 *     passed through — what the orchestrator does with it is a prompt
 *     decision (agent/instructions.md §Command turns), not a dispatch one.
 *     A bare `@bot /task` resolves to DEFAULT_COMMAND.
 *
 * Returns null (do NOT dispatch a turn) when `body` is not a string, the
 * comment does not `@mention` botName, the mention has no trailing tokens, or
 * the bare-form token is not a known command. Matching is case-insensitive
 * (GitHub preserves the author's casing while logins are case-insensitive).
 */
export function parseCommand(body: unknown, botName: string): string | null {
  if (typeof body !== "string") return null;

  const mention = `@${botName.toLowerCase()}`;
  const lower = body.toLowerCase();
  const at = lower.indexOf(mention);
  if (at === -1) return null;

  // Mention boundary: `@my-dev-agent-2` must not match botName `my-dev-agent`.
  const after = lower.charAt(at + mention.length);
  if (after !== "" && /[a-z0-9_-]/u.test(after)) return null;

  const tokens = body
    .slice(at + mention.length)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  if (first === undefined) return null;

  if (first === COMMAND_PREFIX) {
    return tokens[1]?.toLowerCase() ?? DEFAULT_COMMAND;
  }
  return KNOWN_COMMANDS.includes(first) ? first : null;
}

// ---------------------------------------------------------------------------
// PR attribute projection
// ---------------------------------------------------------------------------

function readStringField(raw: unknown, ...path: readonly string[]): string | undefined {
  let cursor: unknown = raw;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

function readNumberField(raw: unknown, ...path: readonly string[]): number | undefined {
  let cursor: unknown = raw;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : undefined;
}

/**
 * Shared PR-attribute projection used by BOTH dispatch paths — the PR-event
 * path (onPullRequest, webhook `pull_request` payload) and the comment path
 * (onComment, PR fetched via REST). The two GitHub shapes share the same field
 * names (`base.sha`, `head.sha`, `head.ref`, `merge_commit_sha`, `user.login`,
 * `changed_files`).
 *
 * Rules this function encodes (each learned the hard way — keep them):
 *  - `defaultGitHubAuth` provides repository / pull_request_number / user_login
 *    but NOT shas or branch, so those are read from the raw payload here.
 *  - Attribute values must be strings (attributes is
 *    Readonly<Record<string, string | readonly string[]>>) — `changed_files`
 *    is stringified here and parsed back in one dedicated place, never ad hoc
 *    in tools.
 *  - Omit absent fields instead of inventing values: `merge_commit_sha` is
 *    legitimately null early in a PR's life, and a fabricated value poisons
 *    any downstream join keyed on it.
 *
 * `headShaHint` preserves the PR-event path's precedence (`pr.headSha` from
 * the normalized event wins over `raw.head.sha`); the comment path passes
 * `null` and reads `head.sha` from the fetched PR body.
 */
export function prAttributesFromRaw(
  raw: unknown,
  headShaHint?: string | null,
): Record<string, string> {
  const baseSha = readStringField(raw, "base", "sha");
  const headSha = headShaHint ?? readStringField(raw, "head", "sha");
  const mergeCommitSha = readStringField(raw, "merge_commit_sha");
  const branch = readStringField(raw, "head", "ref");
  const prAuthorLogin = readStringField(raw, "user", "login");
  const changedFiles = readNumberField(raw, "changed_files");
  return {
    ...(baseSha ? { base_sha: baseSha } : {}),
    ...(headSha ? { head_sha: headSha } : {}),
    ...(mergeCommitSha ? { merge_commit_sha: mergeCommitSha } : {}),
    ...(branch ? { branch } : {}),
    ...(prAuthorLogin ? { pr_author: prAuthorLogin } : {}),
    ...(changedFiles !== undefined ? { changed_files: String(changedFiles) } : {}),
  };
}

function buildPullRequestAuth(
  ctx: GitHubInboundContext,
  pr: GitHubPullRequestEvent,
): SessionAuthContext {
  const base = defaultGitHubAuth(ctx);
  return {
    ...base,
    attributes: {
      ...base.attributes,
      ...prAttributesFromRaw(pr.raw, pr.headSha),
    },
  };
}

function buildCommandAuth(
  ctx: GitHubInboundContext,
  command: string,
  prBody: unknown,
): SessionAuthContext {
  const base = defaultGitHubAuth(ctx);
  return {
    ...base,
    attributes: {
      ...base.attributes,
      ...prAttributesFromRaw(prBody, null),
      // Drives BOTH the orchestrator's turn-mode branching
      // (agent/instructions.md §Command turns) and the per-turn dynamic model
      // routing (agent/agent.ts → COMMAND_MODEL). Set LAST so a raw-payload
      // field of the same name can never clobber it.
      command,
    },
  };
}

/**
 * Fetch the PR a comment lives on. The comment webhook payload does not carry
 * head/base sha or branch, so — per channels/github.mdx §"Arbitrary API calls"
 * — we hit the REST API through `ctx.github.request`, which carries
 * installation-token auth. Fail-soft: if the fetch fails, dispatch anyway with
 * no PR attributes; capability tools then return their documented "no PR
 * context" result instead of stranding the turn.
 */
async function fetchPullRequestBody(
  ctx: GitHubInboundContext,
  pullRequestNumber: number,
): Promise<unknown> {
  try {
    const { owner, name } = ctx.repository;
    const res = await ctx.github.request({
      method: "GET",
      path: `/repos/${owner}/${name}/pulls/${pullRequestNumber}`,
    });
    return res.body;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The dispatch handlers
// ---------------------------------------------------------------------------

/**
 * The estate lookup both handlers gate on. Injectable so dispatch.test.ts can
 * run against a fixture registry instead of the real one in lib/estate.ts
 * (which template users rewrite — tests must survive that).
 */
export type EstateLookup = (
  fullName: string,
) => Pick<EstateRepo, "enabled"> | undefined;

/**
 * PR-event dispatch. Exported for unit tests.
 *
 * Returns `null` (no turn) unless the repo resolves through the estate
 * registry to an ENABLED entry and the action is `opened`/`synchronize`.
 * Resolving through the estate (case-insensitive, accepts bare names — see
 * lib/estate.ts) means gating FAILS CLOSED for unknown repos: a GitHub App
 * installed org-wide can deliver events from repos this agent was never meant
 * to serve.
 *
 * CUSTOMIZE: if automatic PR turns should serve only ONE repo (the reference
 * implementation fences its auto flow to a single primary repo while comment
 * commands work estate-wide), tighten the gate to
 * `findRepo(ctx.repository.fullName)?.repo !== PRIMARY_REPO` — or return null
 * unconditionally to disable PR-event turns and keep mention commands only.
 */
export function onPullRequestDispatch(
  ctx: GitHubInboundContext,
  pr: GitHubPullRequestEvent,
  findRepo: EstateLookup = findEstateRepo,
): GitHubInboundResult {
  if (findRepo(ctx.repository.fullName)?.enabled !== true) return null;
  return pr.action === "opened" || pr.action === "synchronize"
    ? { auth: buildPullRequestAuth(ctx, pr) }
    : null;
}

/**
 * Comment dispatch for `@bot` mention commands. Exported for unit tests.
 * Providing `onComment` REPLACES eve's default mention gate, so this handler
 * owns the whole decision.
 *
 * Returns `null` (no turn — untagged or non-command comments must NOT create
 * sessions; every stray comment on a busy repo would otherwise burn a turn)
 * when:
 *  - the comment is not on a PR;
 *  - the body does not parse as a bot command (see parseCommand's grammar);
 *  - the repo is not enabled in the estate registry.
 *
 * Otherwise dispatches with `defaultGitHubAuth` + the fetched PR's attributes
 * + the `command` attribute (set last).
 */
export async function onCommentDispatch(
  ctx: GitHubInboundContext,
  comment: GitHubComment,
  findRepo: EstateLookup = findEstateRepo,
): Promise<GitHubInboundResult> {
  const pullRequestNumber = ctx.conversation.pullRequestNumber;
  if (pullRequestNumber == null) return null;

  const command = parseCommand(comment.body, BOT_NAME);
  if (command == null) return null;

  if (findRepo(ctx.repository.fullName)?.enabled !== true) return null;

  const prBody = await fetchPullRequestBody(ctx, pullRequestNumber);
  return { auth: buildCommandAuth(ctx, command, prBody) };
}
