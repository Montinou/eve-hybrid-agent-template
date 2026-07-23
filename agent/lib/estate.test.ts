import { describe, expect, it } from "vitest";
import {
  ESTATE,
  enabledRepos,
  findEstateRepo,
  ORG,
  sandboxRuntime,
  tokenCloneUrl,
} from "./estate.ts";

// These tests pin STRUCTURAL invariants of the estate registry (they must
// keep passing after you customize the entries) plus a few example-entry
// assertions that are expected to be updated alongside your customization —
// the latter are marked CUSTOMIZE.

describe("ESTATE invariants", () => {
  it("has a unique dir per repo and a well-formed full name", () => {
    const dirs = new Set(ESTATE.map((r) => r.dir));
    expect(dirs.size).toBe(ESTATE.length);
    expect(ESTATE.every((r) => r.repo.startsWith(`${ORG}/`))).toBe(true);
  });

  it("has at least one enabled repo (the dev-agent needs something to clone)", () => {
    expect(enabledRepos().length).toBeGreaterThan(0);
  });

  it("enabledRepos only returns entries with enabled=true", () => {
    expect(enabledRepos().every((r) => r.enabled)).toBe(true);
  });

  it("every entry declares a non-empty default branch and runtime", () => {
    expect(ESTATE.every((r) => r.defaultBranch.length > 0)).toBe(true);
    expect(ESTATE.every((r) => r.runtime.length > 0)).toBe(true);
  });
});

describe("sandboxRuntime", () => {
  it("returns the shared runtime of the enabled repos", () => {
    // CUSTOMIZE: update if your enabled repos pin a different runtime.
    expect(sandboxRuntime()).toBe("node22");
  });

  it("agrees with every enabled repo (one template = one runtime)", () => {
    const runtime = sandboxRuntime();
    expect(enabledRepos().every((r) => r.runtime === runtime)).toBe(true);
  });
});

describe("findEstateRepo", () => {
  const first = ESTATE[0]!;

  it("matches by exact full name", () => {
    expect(findEstateRepo(first.repo)?.dir).toBe(first.dir);
  });

  it("matches full name case-insensitively", () => {
    expect(findEstateRepo(first.repo.toUpperCase())?.dir).toBe(first.dir);
  });

  it("matches by bare dir name as a convenience", () => {
    expect(findEstateRepo(first.dir)?.dir).toBe(first.dir);
  });

  it("returns undefined for a repo not in the estate", () => {
    expect(findEstateRepo("SomeOrg/not-a-real-repo")).toBeUndefined();
  });

  it("returns undefined for blank input", () => {
    expect(findEstateRepo("   ")).toBeUndefined();
  });

  it("still resolves listed-but-disabled repos (runDevAgent is what gates them)", () => {
    const disabled = ESTATE.find((r) => !r.enabled);
    if (disabled) {
      expect(findEstateRepo(disabled.repo)?.enabled).toBe(false);
    }
  });
});

describe("tokenCloneUrl", () => {
  it("builds an x-access-token https clone URL", () => {
    expect(tokenCloneUrl(`${ORG}/example-app`, "tok123")).toBe(
      `https://x-access-token:tok123@github.com/${ORG}/example-app.git`,
    );
  });
});
