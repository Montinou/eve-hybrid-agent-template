import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildHarnessOptions } from "./dev-agent.ts";

/**
 * Upgrade canary for the one dependency contract whose silent breakage costs
 * money instead of failing loudly: how @ai-sdk/harness-claude-code decides
 * which credential the nested Claude Code CLI authenticates with.
 *
 * Keep this test when you fork the template. It is the only thing standing
 * between a routine dependency bump and a dev-agent that quietly bills every
 * run through the AI Gateway at API prices.
 *
 * Why pin a version rather than test behaviour: the resolver
 * (`resolveClaudeCodeEnv`) is not exported, and observing its output for real
 * needs a booted sandbox. So this pins the version whose resolution was READ
 * and verified, and fails on any bump — turning "someone upgraded and the
 * dev-agent quietly moved to AI Gateway billing at API prices" into a CI
 * failure that costs a two-minute re-read.
 *
 * Verified by reading dist/index.js of each version:
 *
 * - 1.0.42 (previous): `auth` accepted only the object form, and
 *   `resolveClaudeCodeEnv` checked `auth?.anthropic` first, so the explicit
 *   block won and the Gateway env credentials were never consulted.
 * - 1.0.88 (current): the object form is deprecated in favour of a mode
 *   string. `normalizeClaudeCodeAuthToLegacyAuth` maps `"direct"` to
 *   `{ anthropic: {} }`, which takes the same anthropic branch and reads
 *   ANTHROPIC_AUTH_TOKEN from the environment. `"auto"` — the DEFAULT when
 *   `auth` is omitted — returns Gateway credentials whenever they exist, and
 *   on Vercel the OIDC token always exists. That default is the leak.
 *
 * DO NOT paper over a failure here by bumping the constant. Re-read
 * `resolveClaudeCodeEnv` in the new version and confirm the mode we pass
 * still reaches `pickAnthropic` with the subscription token.
 */
const VERIFIED_HARNESS_CLAUDE_CODE_VERSION = "1.0.88";

describe("harness-claude-code auth contract", () => {
  it("is pinned to the version whose credential resolution was verified", () => {
    const require = createRequire(import.meta.url);
    const { version } = require("@ai-sdk/harness-claude-code/package.json") as {
      version: string;
    };
    expect(
      version,
      "@ai-sdk/harness-claude-code changed version. Re-read resolveClaudeCodeEnv " +
        "in the new dist and confirm `auth: \"direct\"` still routes to the " +
        "Anthropic credential before updating this pin — a regression here bills " +
        "the dev-agent through the AI Gateway at API prices instead of the Claude " +
        "subscription, silently and with no failing test.",
    ).toBe(VERIFIED_HARNESS_CLAUDE_CODE_VERSION);
  });

  it("never leaves auth at its Gateway-preferring default when a token exists", () => {
    const opts = buildHarnessOptions({
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oat-test",
    } as NodeJS.ProcessEnv) as Record<string, unknown>;
    expect(opts.auth).toBe("direct");
    expect(opts.auth).not.toBe("auto");
    expect(opts.auth).not.toBe("ai-gateway");
  });
});
