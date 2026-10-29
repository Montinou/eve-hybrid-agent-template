import { afterEach, describe, expect, it, vi } from "vitest";
// execSync WITH a shell is deliberate below: the production sandbox runs
// this command through a POSIX shell, and the regression under test is a
// shell-quoting collision. The command is builder-generated (no user input);
// secret values travel via env, never the command string.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapHash,
  buildDevSandboxCreateOptions,
  buildSessionSecretsCommand,
  devForkSandboxId,
  MAX_DEV_AGENT_TIME_BUDGET_MS,
  parseDevTaskSecrets,
  parseResultMarker,
  redactSecrets,
  resolveBudgetMs,
  SESSION_SECRETS_PATH,
} from "./dev-agent.ts";
import { isHarnessTemplateName, SANDBOX_TAG_KEY, SANDBOX_TAG_VALUE } from "./template-sweep.ts";

describe("resolveBudgetMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 700000 when nothing is configured", () => {
    // No stubbing here on purpose: this must hold under the real process env
    // (CI doesn't set DEV_AGENT_TIME_BUDGET_MS), proving rollback is just
    // "unset the env var" rather than a code change.
    expect(resolveBudgetMs(undefined)).toBe(700_000);
  });

  it("honors DEV_AGENT_TIME_BUDGET_MS from the environment", () => {
    // The env var is read at call time (inside resolveBudgetMs), so stubbing
    // alone is enough — no module re-import needed.
    vi.stubEnv("DEV_AGENT_TIME_BUDGET_MS", "123456");
    expect(resolveBudgetMs(undefined)).toBe(123_456);
  });

  it("prefers an explicit positive override over the env", () => {
    vi.stubEnv("DEV_AGENT_TIME_BUDGET_MS", "123456");
    expect(resolveBudgetMs(555_000)).toBe(555_000);
  });

  it("ignores a non-positive or non-finite explicit override", () => {
    expect(resolveBudgetMs(0)).toBe(700_000);
    expect(resolveBudgetMs(-1)).toBe(700_000);
    expect(resolveBudgetMs(Number.NaN)).toBe(700_000);
  });

  it("clamps an environment value that exceeds MAX_DEV_AGENT_TIME_BUDGET_MS", () => {
    vi.stubEnv("DEV_AGENT_TIME_BUDGET_MS", "900000");
    expect(resolveBudgetMs(undefined)).toBe(MAX_DEV_AGENT_TIME_BUDGET_MS);
    expect(resolveBudgetMs(undefined)).toBe(750_000);
  });

  it("honors the boundary value when env exactly equals MAX_DEV_AGENT_TIME_BUDGET_MS", () => {
    vi.stubEnv("DEV_AGENT_TIME_BUDGET_MS", "750000");
    expect(resolveBudgetMs(undefined)).toBe(750_000);
  });

  it("clamps an explicit override that exceeds MAX_DEV_AGENT_TIME_BUDGET_MS", () => {
    expect(resolveBudgetMs(900_000)).toBe(MAX_DEV_AGENT_TIME_BUDGET_MS);
    expect(resolveBudgetMs(900_000)).toBe(750_000);
  });
});

describe("bootstrapHash", () => {
  const base = [{ repo: "your-github-org/example-app", branch: "main" }];
  const grown = [
    ...base,
    { repo: "your-github-org/example-service", branch: "main" },
  ];

  it("is stable for the same inputs", () => {
    expect(bootstrapHash({ repos: base, recipe: 1 })).toBe(
      bootstrapHash({ repos: base, recipe: 1 }),
    );
  });

  it("is order-insensitive over the repo set (sorted internally)", () => {
    expect(bootstrapHash({ repos: grown, recipe: 1 })).toBe(
      bootstrapHash({ repos: [...grown].reverse(), recipe: 1 }),
    );
  });

  it("changes when the enabled repo/branch set grows", () => {
    expect(bootstrapHash({ repos: base, recipe: 1 })).not.toBe(
      bootstrapHash({ repos: grown, recipe: 1 }),
    );
  });

  it("changes when a branch changes", () => {
    const rebranched = [{ repo: "your-github-org/example-app", branch: "dev" }];
    expect(bootstrapHash({ repos: base, recipe: 1 })).not.toBe(
      bootstrapHash({ repos: rebranched, recipe: 1 }),
    );
  });

  it("changes when only the recipe version bumps", () => {
    expect(bootstrapHash({ repos: base, recipe: 1 })).not.toBe(
      bootstrapHash({ repos: base, recipe: 2 }),
    );
  });
});

describe("parseResultMarker", () => {
  it("parses the fallback result marker after preceding noise", () => {
    const text =
      'noise\n===DEV_AGENT_RESULT===\n{"status":"ok","summary":"done"}';
    expect(parseResultMarker(text)?.status).toBe("ok");
    expect(parseResultMarker(text)?.summary).toBe("done");
  });

  it("uses the LAST marker when several are present", () => {
    const text =
      '===DEV_AGENT_RESULT===\n{"status":"failed","summary":"first"}\n' +
      '===DEV_AGENT_RESULT===\n{"status":"partial","summary":"second"}';
    expect(parseResultMarker(text)?.status).toBe("partial");
  });

  it("returns null when the marker is absent", () => {
    expect(parseResultMarker("just some model output")).toBeNull();
  });

  it("returns null when the marker payload is not valid JSON", () => {
    expect(parseResultMarker("===DEV_AGENT_RESULT===\n{not json")).toBeNull();
  });

  it("returns null when trailing text follows the JSON payload (everything after the marker must parse)", () => {
    const text =
      '===DEV_AGENT_RESULT===\n{"status":"ok","summary":"done"}\ntrailing prose';
    expect(parseResultMarker(text)).toBeNull();
  });

  it("coerces an unknown status to failed", () => {
    const text = '===DEV_AGENT_RESULT===\n{"status":"weird","summary":"x"}';
    expect(parseResultMarker(text)?.status).toBe("failed");
  });

  it("coerces a missing summary to the empty string", () => {
    const text = '===DEV_AGENT_RESULT===\n{"status":"ok"}';
    expect(parseResultMarker(text)?.summary).toBe("");
  });
});

describe("redactSecrets", () => {
  it("redacts an Anthropic sk-ant- token", () => {
    expect(redactSecrets("token=sk-ant-ABC12345xyz")).toBe("token=[REDACTED]");
  });

  it("redacts a GitHub ghs_ (server-to-server) token", () => {
    expect(redactSecrets("GH ghs_ABCDEFGH1234 done")).toBe("GH [REDACTED] done");
  });

  it("redacts a GitHub ghp_ (personal access) token", () => {
    expect(redactSecrets("GH ghp_ABCDEFGH1234 done")).toBe("GH [REDACTED] done");
  });

  it("redacts a github_pat_ fine-grained token", () => {
    expect(redactSecrets("pat=github_pat_ABCDEFGH_1234;")).toBe("pat=[REDACTED];");
  });

  it("redacts a Bearer header value", () => {
    expect(redactSecrets("Authorization: Bearer abcd1234efgh")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  it("redacts multiple distinct secrets in the same text", () => {
    const text = "sk-ant-ABC12345 and Bearer zzzz9999yyyy";
    expect(redactSecrets(text)).toBe("[REDACTED] and [REDACTED]");
  });

  it("leaves clean text untouched", () => {
    const clean = "estate synced ok, finishReason=stop, no secrets here";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

describe("parseDevTaskSecrets", () => {
  it("parses a valid string→string JSON object", () => {
    expect(
      parseDevTaskSecrets('{"PREVIEW_USER":"someone","PREVIEW_PASSWORD":"hunter2"}'),
    ).toEqual({ PREVIEW_USER: "someone", PREVIEW_PASSWORD: "hunter2" });
  });

  it("resolves undefined for undefined, empty, and whitespace-only input", () => {
    expect(parseDevTaskSecrets(undefined)).toBeUndefined();
    expect(parseDevTaskSecrets("")).toBeUndefined();
    expect(parseDevTaskSecrets("   ")).toBeUndefined();
  });

  it("fails soft (undefined) on malformed JSON", () => {
    expect(parseDevTaskSecrets("{not json")).toBeUndefined();
  });

  it("fails soft (undefined) on non-object JSON values", () => {
    expect(parseDevTaskSecrets("null")).toBeUndefined();
    expect(parseDevTaskSecrets('["a","b"]')).toBeUndefined();
    expect(parseDevTaskSecrets('"just a string"')).toBeUndefined();
    expect(parseDevTaskSecrets("42")).toBeUndefined();
  });

  it("drops non-string and empty values rather than coercing them", () => {
    expect(
      parseDevTaskSecrets('{"OK":"yes","NUM":7,"NULL":null,"EMPTY":""}'),
    ).toEqual({ OK: "yes" });
  });

  it("drops keys that are not env-var-shaped (they would corrupt the comma-joined DEV_AGENT_SECRET_KEYS split)", () => {
    expect(
      parseDevTaskSecrets('{"GOOD_KEY":"a","BAD,KEY":"b","also bad":"c","1LEADING":"d"}'),
    ).toEqual({ GOOD_KEY: "a" });
  });

  it("resolves undefined when every entry is dropped", () => {
    expect(parseDevTaskSecrets('{"NUM":7,"EMPTY":""}')).toBeUndefined();
    expect(parseDevTaskSecrets("{}")).toBeUndefined();
  });
});

describe("SESSION_SECRETS_PATH", () => {
  it("is an absolute /tmp path capability prompt builders can reference by name", () => {
    expect(SESSION_SECRETS_PATH).toBe("/tmp/dev-task-secrets.json");
  });
});

describe("buildSessionSecretsCommand", () => {
  it("never embeds key names or double quotes in the command text", () => {
    const { command, keysEnv } = buildSessionSecretsCommand([
      "PREVIEW_USER",
      "PREVIEW_PASSWORD",
    ]);
    expect(command).not.toContain("PREVIEW_USER");
    expect(command).not.toContain("PREVIEW_PASSWORD");
    expect(keysEnv).toEqual({
      DEV_AGENT_SECRET_KEYS: "PREVIEW_USER,PREVIEW_PASSWORD",
    });
    // The sandbox runs this through a POSIX shell: a double quote inside the
    // single-quoted node program would re-open shell interpretation (the
    // exact bug this builder replaced). Only the JS-internal double quotes
    // inside the single-quoted segment are allowed.
    const singleQuoted = command.match(/'[^']*'/g) ?? [];
    const outside = singleQuoted.reduce(
      (acc, seg) => acc.replace(seg, ""),
      command,
    );
    expect(outside).not.toContain('"');
  });

  it("defaults the target path to SESSION_SECRETS_PATH", () => {
    const { command } = buildSessionSecretsCommand(["A"]);
    expect(command).toContain(SESSION_SECRETS_PATH);
  });

  it("writes the exact secrets JSON when the command actually runs in a shell", () => {
    // Rewritten target path: never touch the real /tmp SESSION_SECRETS_PATH.
    const dir = fs.mkdtempSync(join(tmpdir(), "dev-task-secrets-test-"));
    const path = join(dir, "dev-task-secrets.json");
    // Values carry shell metacharacters on purpose ($, ", ', spaces, {},
    // newline): they must survive verbatim because they travel via env, not
    // the command string.
    const secrets = {
      PREVIEW_USER: "someone@example.com",
      PREVIEW_PASSWORD: 'p4$s"word\'{}',
      MULTILINE_PEM: "line one\nline two",
    };
    const { command, keysEnv } = buildSessionSecretsCommand(
      Object.keys(secrets),
      path,
    );
    for (const value of Object.values(secrets)) {
      expect(command).not.toContain(value);
    }
    try {
      execSync(command, {
        shell: "/bin/sh",
        env: { ...process.env, ...secrets, ...keysEnv },
      });
      expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual(secrets);
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDevSandboxCreateOptions", () => {
  // Options for createVercelNetworkSandboxSession (the replacement for the
  // deprecated createVercelSandbox provider). The template and every fork
  // are created from them.
  it("creates NON-persistent sandboxes so a fork's stop()/destroy() mints no snapshot", () => {
    // @vercel/sandbox README: "Sandboxes are persistent by default: the
    // filesystem is snapshotted when a sandbox stops". A throwaway fork must
    // opt out, or every run leaks a multi-GB snapshot.
    expect(buildDevSandboxCreateOptions().persistent).toBe(false);
  });

  it("keeps the bridge port, the app tag, 8 vCPUs and the 45-minute lifetime", () => {
    const opts = buildDevSandboxCreateOptions();
    expect(opts.ports).toEqual([4000]);
    expect(opts.tags).toEqual({ [SANDBOX_TAG_KEY]: SANDBOX_TAG_VALUE });
    expect(opts.resources).toEqual({ vcpus: 8 });
    expect(opts.timeout).toBe(45 * 60 * 1000);
  });

  it("selects the base by `runtime` only (runtime and image are mutually exclusive)", () => {
    const opts = buildDevSandboxCreateOptions() as Record<string, unknown>;
    expect(typeof opts.runtime).toBe("string");
    expect("image" in opts).toBe(false);
  });

  it("stamps TEMPLATE_SNAPSHOT_EXPIRATION_MS on the template snapshot", () => {
    vi.stubEnv("TEMPLATE_SNAPSHOT_EXPIRATION_MS", String(3 * 24 * 60 * 60 * 1000));
    expect(buildDevSandboxCreateOptions().snapshotExpiration).toBe(3 * 24 * 60 * 60 * 1000);
    vi.unstubAllEnvs();
  });
});

describe("devForkSandboxId", () => {
  it("names forks so sweepSessionSnapshots finds them and the template sweep never does", () => {
    const id = devForkSandboxId("dev-task-repo-abc");
    expect(id).toBe("ai-sdk-harness-session-dev-task-repo-abc");
    expect(isHarnessTemplateName(id)).toBe(false);
  });
});
