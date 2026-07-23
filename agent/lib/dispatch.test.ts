import { describe, expect, it, vi } from "vitest";
import type {
  GitHubComment,
  GitHubInboundContext,
  GitHubPullRequestEvent,
} from "eve/channels/github";
import {
  BOT_NAME,
  DEFAULT_COMMAND,
  onCommentDispatch,
  onPullRequestDispatch,
  parseCommand,
  prAttributesFromRaw,
} from "./dispatch.ts";
import type { EstateLookup } from "./dispatch.ts";

// ---------------------------------------------------------------------------
// Fixtures. The estate lookup is INJECTED (see EstateLookup in dispatch.ts) so
// these tests exercise the dispatch gates against a fixture registry and keep
// passing when template users rewrite lib/estate.ts with their own repos.
// Case-insensitive name resolution is lib/estate.ts's own concern, covered by
// estate.test.ts — the injected fake here matches exactly.
// ---------------------------------------------------------------------------

const ENABLED_REPO = "example-org/enabled-repo";
const DISABLED_REPO = "example-org/disabled-repo";

const fakeEstate: EstateLookup = (fullName) =>
  ({
    [ENABLED_REPO]: { enabled: true },
    [DISABLED_REPO]: { enabled: false },
  })[fullName];

// A PR REST/webhook body carrying the fields prAttributesFromRaw reads.
function prBody(overrides: Record<string, unknown> = {}) {
  return {
    base: { sha: "base111" },
    head: { sha: "head222", ref: "fix/example-feature" },
    merge_commit_sha: "merge333",
    user: { login: "octocat" },
    changed_files: 4,
    ...overrides,
  };
}

function makeCtx(input: {
  fullName: string;
  pullRequestNumber: number | null;
  request?: (args: {
    method: string;
    path: string;
  }) => Promise<{ body: unknown; ok: boolean; status: number }>;
}): GitHubInboundContext {
  const [owner, name] = input.fullName.split("/");
  const request =
    input.request ?? vi.fn(async () => ({ body: prBody(), ok: true, status: 200 }));
  return {
    conversation: {
      kind: input.pullRequestNumber == null ? "issue" : "pull_request",
      issueNumber: input.pullRequestNumber ?? 42,
      pullRequestNumber: input.pullRequestNumber,
    },
    delivery: { id: "delivery-1", event: "issue_comment", hookId: "hook-1" },
    github: {
      installationId: 99,
      repository: { fullName: input.fullName, id: 7, name, owner, private: false },
      request,
    },
    repository: { fullName: input.fullName, id: 7, name, owner, private: false },
    sender: { id: 5, login: "commenter", type: "User", htmlUrl: undefined, url: undefined },
    thread: { kind: "pull_request" },
  } as unknown as GitHubInboundContext;
}

function makePr(action: string): GitHubPullRequestEvent {
  return {
    action,
    headSha: "head222",
    pullRequestNumber: 123,
    raw: prBody(),
  } as unknown as GitHubPullRequestEvent;
}

function comment(body: string): GitHubComment {
  return {
    author: undefined,
    body,
    htmlUrl: undefined,
    id: 1,
    raw: {},
    url: undefined,
  } as unknown as GitHubComment;
}

// ---------------------------------------------------------------------------
// parseCommand — the pure grammar
// ---------------------------------------------------------------------------

describe("parseCommand", () => {
  it("parses the bare form: a known command word after the mention", () => {
    expect(parseCommand(`@${BOT_NAME} run`, BOT_NAME)).toBe("run");
  });

  it("is case-insensitive on mention and command", () => {
    expect(parseCommand(`@${BOT_NAME.toUpperCase()} RUN`, BOT_NAME)).toBe("run");
  });

  it("returns null for prose that merely mentions the bot — no session for chatter", () => {
    expect(parseCommand(`thanks @${BOT_NAME}!`, BOT_NAME)).toBeNull();
    expect(parseCommand(`can @${BOT_NAME} take a look?`, BOT_NAME)).toBeNull();
  });

  it("returns null for a mention with nothing after it", () => {
    expect(parseCommand(`@${BOT_NAME}`, BOT_NAME)).toBeNull();
  });

  it("returns null without a mention, even when a command word is present", () => {
    expect(parseCommand("please run this", BOT_NAME)).toBeNull();
  });

  it("parses the explicit form: /task passes any subcommand through", () => {
    expect(parseCommand(`@${BOT_NAME} /task hello`, BOT_NAME)).toBe("hello");
    expect(parseCommand(`@${BOT_NAME} /task Run`, BOT_NAME)).toBe("run");
  });

  it("maps a bare /task to the default command", () => {
    expect(parseCommand(`@${BOT_NAME} /task`, BOT_NAME)).toBe(DEFAULT_COMMAND);
  });

  it("does not treat /task glued to a word as the explicit prefix", () => {
    expect(parseCommand(`@${BOT_NAME} /taskrun`, BOT_NAME)).toBeNull();
  });

  it("respects the mention boundary — a longer handle is a different bot", () => {
    expect(parseCommand(`@${BOT_NAME}-2 run`, BOT_NAME)).toBeNull();
  });

  it("returns null for non-string bodies", () => {
    expect(parseCommand(undefined, BOT_NAME)).toBeNull();
    expect(parseCommand(42, BOT_NAME)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// prAttributesFromRaw — omit-when-absent projection
// ---------------------------------------------------------------------------

describe("prAttributesFromRaw", () => {
  it("projects every present field, stringifying numbers", () => {
    expect(prAttributesFromRaw(prBody(), null)).toEqual({
      base_sha: "base111",
      head_sha: "head222",
      merge_commit_sha: "merge333",
      branch: "fix/example-feature",
      pr_author: "octocat",
      changed_files: "4",
    });
  });

  it("omits merge_commit_sha when GitHub has not computed it yet (null)", () => {
    const attrs = prAttributesFromRaw(prBody({ merge_commit_sha: null }), null);
    expect(attrs).not.toHaveProperty("merge_commit_sha");
  });

  it("prefers the normalized event head sha over the raw payload's", () => {
    expect(prAttributesFromRaw(prBody(), "hint999").head_sha).toBe("hint999");
  });

  it("returns an empty projection for an unusable payload", () => {
    expect(prAttributesFromRaw(null, null)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// onPullRequestDispatch — estate-enabled + action gates
// ---------------------------------------------------------------------------

describe("onPullRequestDispatch", () => {
  it("dispatches an opened PR on an enabled repo with full PR auth attributes", () => {
    const result = onPullRequestDispatch(
      makeCtx({ fullName: ENABLED_REPO, pullRequestNumber: 123 }),
      makePr("opened"),
      fakeEstate,
    );
    expect(result).not.toBeNull();
    const attrs = result!.auth!.attributes;
    expect(attrs.repository).toBe(ENABLED_REPO);
    expect(attrs.base_sha).toBe("base111");
    expect(attrs.head_sha).toBe("head222");
    expect(attrs.branch).toBe("fix/example-feature");
    expect(attrs.merge_commit_sha).toBe("merge333");
    expect(attrs.changed_files).toBe("4");
    // PR-event turns must NOT carry a command attribute — only comment turns do.
    expect(attrs.command).toBeUndefined();
  });

  it("dispatches on synchronize", () => {
    expect(
      onPullRequestDispatch(
        makeCtx({ fullName: ENABLED_REPO, pullRequestNumber: 1 }),
        makePr("synchronize"),
        fakeEstate,
      ),
    ).not.toBeNull();
  });

  it("ignores non-opened/synchronize actions", () => {
    expect(
      onPullRequestDispatch(
        makeCtx({ fullName: ENABLED_REPO, pullRequestNumber: 1 }),
        makePr("closed"),
        fakeEstate,
      ),
    ).toBeNull();
  });

  it("returns null for a repo in the estate but not enabled", () => {
    expect(
      onPullRequestDispatch(
        makeCtx({ fullName: DISABLED_REPO, pullRequestNumber: 1 }),
        makePr("opened"),
        fakeEstate,
      ),
    ).toBeNull();
  });

  it("fails closed for a repo outside the estate entirely", () => {
    expect(
      onPullRequestDispatch(
        makeCtx({ fullName: "example-org/unknown-repo", pullRequestNumber: 1 }),
        makePr("opened"),
        fakeEstate,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onCommentDispatch — command routing, gated by the estate enabled flag
// ---------------------------------------------------------------------------

describe("onCommentDispatch", () => {
  it("dispatches a command comment with the command attribute + PR auth fetched from the API", async () => {
    const ctx = makeCtx({ fullName: ENABLED_REPO, pullRequestNumber: 123 });
    const result = await onCommentDispatch(ctx, comment(`@${BOT_NAME} run`), fakeEstate);
    expect(result).not.toBeNull();
    const attrs = result!.auth!.attributes;
    expect(attrs.command).toBe("run");
    // Head sha and branch come from the fetched PR, not the comment payload.
    expect(attrs.head_sha).toBe("head222");
    expect(attrs.branch).toBe("fix/example-feature");
    expect(attrs.repository).toBe(ENABLED_REPO);
    // The PR was fetched via the arbitrary-API escape hatch with the right path.
    expect(ctx.github.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/repos/example-org/enabled-repo/pulls/123",
    });
  });

  it("passes an explicit-form subcommand through for the orchestrator to answer", async () => {
    const ctx = makeCtx({ fullName: ENABLED_REPO, pullRequestNumber: 1 });
    const result = await onCommentDispatch(ctx, comment(`@${BOT_NAME} /task hello`), fakeEstate);
    expect(result!.auth!.attributes.command).toBe("hello");
  });

  it("returns null (no turn) for a comment that is not on a PR", async () => {
    const ctx = makeCtx({ fullName: ENABLED_REPO, pullRequestNumber: null });
    const result = await onCommentDispatch(ctx, comment(`@${BOT_NAME} run`), fakeEstate);
    expect(result).toBeNull();
    expect(ctx.github.request).not.toHaveBeenCalled();
  });

  it("returns null for a mention without a command — untagged/chatty comments must not create sessions", async () => {
    const ctx = makeCtx({ fullName: ENABLED_REPO, pullRequestNumber: 1 });
    const result = await onCommentDispatch(
      ctx,
      comment(`@${BOT_NAME} can you take a look?`),
      fakeEstate,
    );
    expect(result).toBeNull();
    expect(ctx.github.request).not.toHaveBeenCalled();
  });

  it("returns null on a repo where the estate is not enabled, even with a valid command", async () => {
    const ctx = makeCtx({ fullName: DISABLED_REPO, pullRequestNumber: 1 });
    const result = await onCommentDispatch(ctx, comment(`@${BOT_NAME} run`), fakeEstate);
    expect(result).toBeNull();
    expect(ctx.github.request).not.toHaveBeenCalled();
  });

  it("still dispatches (degraded) when the PR fetch fails — capabilities fail-soft on the missing context", async () => {
    const ctx = makeCtx({
      fullName: ENABLED_REPO,
      pullRequestNumber: 1,
      request: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const result = await onCommentDispatch(ctx, comment(`@${BOT_NAME} run`), fakeEstate);
    expect(result).not.toBeNull();
    const attrs = result!.auth!.attributes;
    expect(attrs.command).toBe("run");
    // No branch/head_sha because the fetch failed — omitted, never invented.
    expect(attrs.branch).toBeUndefined();
    expect(attrs.head_sha).toBeUndefined();
  });
});
