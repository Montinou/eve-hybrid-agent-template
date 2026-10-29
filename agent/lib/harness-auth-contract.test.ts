import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createVercelNetworkSandboxSessionFromNativeSandbox } from "@ai-sdk/sandbox-vercel";
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
 * Verified by reading dist/index.js (and src/) of each version:
 *
 * - 1.0.42: `auth` accepted only the object form, and
 *   `resolveClaudeCodeEnv` checked `auth?.anthropic` first, so the explicit
 *   block won and the Gateway env credentials were never consulted.
 * - 1.0.88: the object form was deprecated in favour of a mode string.
 *   `normalizeClaudeCodeAuthToLegacyAuth` mapped `"direct"` to
 *   `{ anthropic: {} }`, which took the same anthropic branch and read
 *   ANTHROPIC_AUTH_TOKEN from the environment.
 * - 1.0.172 (current): `auth` is `"auto" | "ai-gateway" | "direct"` or a flat
 *   string record that REPLACES the process env for credential discovery
 *   (the nested `{ anthropic: {...} }` object form is gone and now throws).
 *   `resolveClaudeCodeEnv` (src/claude-code-auth.ts:95-125) returns
 *   `pickAnthropic` for `"direct"` BEFORE `getAiGatewayAuthFromEnv` is ever
 *   called, and `resolveClaudeCodeAuthenticationMode` (:127-145) maps
 *   `"direct"` to `"direct"`. `resolveClaudeCodeAuthentication`
 *   (src/claude-code-subscription.ts:56-90) returns that env unchanged when a
 *   direct credential is present. The real token then stays on the host: the
 *   sandbox gets a placeholder and the host swaps the real
 *   `Authorization: Bearer` in at egress, only for requests to
 *   `ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"` in direct mode
 *   (claude-code-auth.ts:28-31, 51-66; claude-code-subscription.ts:29-54).
 *   `"auto"` — still the DEFAULT when `auth` is omitted — returns Gateway
 *   credentials whenever they exist (claude-code-auth.ts:114-119), and on
 *   Vercel the OIDC token always exists. That default is the leak.
 *
 * DO NOT paper over a failure here by bumping the constant. Re-read
 * `resolveClaudeCodeEnv` in the new version and confirm the mode we pass
 * still reaches `pickAnthropic` with the subscription token.
 */
const VERIFIED_HARNESS_CLAUDE_CODE_VERSION = "1.0.172";

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

  it("runs the dev-agent in a sandbox session that supports egress credential brokering", () => {
    // The harness keeps the real token on the host ONLY when the sandbox
    // session has addRequestTransformations (claude-code-harness.ts: the
    // placeholder + egress swap branch). Without it, applyCredentialForwarding
    // forwards the real token into the sandbox and the harness only warns.
    // dev-agent.ts builds its forks with createVercelNetworkSandboxSession,
    // which wraps the native sandbox exactly like this.
    const session = createVercelNetworkSandboxSessionFromNativeSandbox(
      {
        name: "ai-sdk-harness-session-contract",
        currentSession: () => ({ cwd: "/vercel/sandbox" }),
      } as unknown as Parameters<typeof createVercelNetworkSandboxSessionFromNativeSandbox>[0],
    ) as unknown as Record<string, unknown>;
    expect(typeof session.addRequestTransformations).toBe("function");
  });

  it("refuses ANTHROPIC_BASE_URL next to the subscription token", () => {
    // In direct mode the host swaps the real bearer in only for requests to
    // `ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"`
    // (claude-code-auth.ts:28-31). A base URL in the env would redirect the
    // swapped-in token to whatever host it names, Gateway included.
    expect(() =>
      buildHarnessOptions({
        ANTHROPIC_AUTH_TOKEN: "sk-ant-oat-test",
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it("refuses ANTHROPIC_API_KEY next to the subscription token", () => {
    // pickAnthropic (claude-code-auth.ts:147-165) merges ANTHROPIC_API_KEY
    // into the sandbox env even in direct mode, re-routing billing.
    expect(() =>
      buildHarnessOptions({
        ANTHROPIC_AUTH_TOKEN: "sk-ant-oat-test",
        ANTHROPIC_API_KEY: "sk-ant-api-test",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});
