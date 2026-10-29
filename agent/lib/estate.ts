// The covered repo estate for the dev-agent. Single source of truth for what
// the sandbox clones at boot, each repo's default branch (= PR target), how to
// install its dependencies, and whether the dev-agent is allowed to run
// against it.
//
// Design notes carried over from the proven reference implementation:
//   - `repo` is the FULL GitHub name ("<owner>/<name>"), so a PR webhook's
//     `repository.full_name` resolves directly via findEstateRepo().
//   - `enabled` gates whether the dev-agent may run against a repo AND
//     whether the sandbox clones it at bootstrap. A repo that is listed but
//     disabled resolves via findEstateRepo (useful for diagnostics), but
//     runDevAgent fail-softs on it.
//
// Enabling a new repo means flipping `enabled` AND invalidating the sandbox
// template snapshot. The dev-agent's bootstrap hash covers the enabled
// repo+branch set by construction, so the invalidation is automatic — but the
// GitHub App must be INSTALLED on the new repo first (App installation is
// per-repo and fails silently otherwise: clones 404 with a valid-looking
// token). See docs/05-dev-agent.md.

// CUSTOMIZE: your GitHub org (or user) that owns the estate repos.
export const ORG = "your-github-org";

// The sandbox estate root the dev-agent's sessions clone every enabled repo
// under (one directory per repo, keyed by EstateRepo.dir). Single source of
// truth: dev-agent.ts and every capability prompt builder
// (build-task-prompt.ts, and your future domain-specific builders) import
// this instead of redefining their own copy of the literal.
export const ESTATE_ROOT = "/vercel/sandbox/estate";

/**
 * Vercel Sandbox stock runtime id (currently "node22", "node24" or "node26";
 * the `(string & {})` arm keeps the union open for future ids while
 * preserving autocomplete). IMPORTANT: this must match the TARGET repo's
 * engines pin, NOT the agent app's own node version (the agent runs on node
 * 24.x; a target repo pinned to node 22 needs a node22 sandbox). One shared
 * template = one runtime — see sandboxRuntime() below.
 *
 * Forward note: `@vercel/sandbox` 3.0.0 DEPRECATED `runtime` in favor of
 * Vercel Managed Images (`image: "vercel/sandbox/node:24"`, defaulting to the
 * Ubuntu-based `vercel/sandbox/universal`), and passing both is an error.
 * `runtime` still works in @vercel/sandbox 3.9.1 (typed `@deprecated Use
 * \`image\` instead`, no runtime warning), and the option this value feeds
 * is `buildDevSandboxCreateOptions()` in dev-agent.ts, passed to
 * `createVercelNetworkSandboxSession`, which accepts either `runtime` or
 * `image`. Moving to `image` changes the base OS image of every dev-agent
 * sandbox (CA bundle paths, package managers), so it is a recipe change of
 * its own: bump RECIPE_VERSION and re-verify the CA prelude when you make it.
 */
export type SandboxRuntime = "node22" | "node24" | "node26" | (string & {});

export interface EstateRepo {
  /** Full GitHub repo name, e.g. "your-github-org/example-app". */
  repo: string;
  /** Checkout directory name inside the sandbox estate root. */
  dir: string;
  /** Branch PRs target (and the branch cloned/synced at session start). */
  defaultBranch: string;
  /** Dependency install strategy; drives the bootstrap/session install command. */
  packageManager: "yarn" | "pnpm" | "npm";
  /** Sandbox runtime this repo's engines pin requires (see SandboxRuntime). */
  runtime: SandboxRuntime;
  /**
   * false = clone-only: the repo is checked out at bootstrap/session but its
   * dependencies are NEVER installed in the sandbox. Use for heavy stacks
   * whose install is slow/fragile enough to endanger the shared template
   * build (a bootstrap failure kills the dev-agent for EVERY repo).
   * Code-reading capabilities are unaffected; build-running ones degrade
   * fail-soft on such repos.
   */
  installDeps: boolean;
  /** Gates dev-agent runs + sandbox cloning. false = the dev-agent never runs here. */
  enabled: boolean;
}

export const ESTATE: readonly EstateRepo[] = [
  {
    // CUSTOMIZE: replace with a real repo of yours. This is the one enabled
    // example the template ships with — clone it per repo you cover. Check
    // the repo's engines/.nvmrc for the correct `runtime`, and remember to
    // install your GitHub App on every repo you add here.
    repo: `${ORG}/example-app`,
    dir: "example-app",
    defaultBranch: "main",
    packageManager: "pnpm",
    runtime: "node22",
    installDeps: true,
    enabled: true,
  },
  {
    // CUSTOMIZE: the disabled-entry pattern. Listed repos that are not (yet)
    // enabled resolve via findEstateRepo for diagnostics, but runDevAgent
    // fail-softs on them and the sandbox never clones them. `installDeps:
    // false` here also demonstrates the clone-only escape hatch for repos
    // whose install is too heavy for the shared template.
    repo: `${ORG}/example-service`,
    dir: "example-service",
    defaultBranch: "main",
    packageManager: "npm",
    runtime: "node22",
    installDeps: false,
    enabled: false,
  },
];

/** Repos the dev-agent may run against right now. */
export function enabledRepos(): readonly EstateRepo[] {
  return ESTATE.filter((r) => r.enabled);
}

/**
 * The single sandbox runtime the shared template is built with. One template
 * = one runtime, so every ENABLED repo must agree on its engines pin. This
 * throws (loudly, at run/warm time — both callers convert the throw into a
 * structured failure) when enabled repos diverge, because silently picking
 * one runtime would break the other repo's installs/builds in confusing
 * ways. If your pins genuinely diverge, either split the estates across two
 * agents or install per-repo node versions (nvm/corepack) in the bootstrap
 * recipe and bump RECIPE_VERSION.
 */
export function sandboxRuntime(): SandboxRuntime {
  const enabled = enabledRepos();
  const runtimes = [...new Set(enabled.map((r) => r.runtime))];
  if (runtimes.length > 1) {
    throw new Error(
      `Enabled estate repos disagree on sandbox runtime (${runtimes.join(", ")}). ` +
        "One shared template = one runtime; reconcile the pins or split the estate.",
    );
  }
  return runtimes[0] ?? "node22";
}

/**
 * Resolve an estate repo from a PR's repository name. Matches the full name
 * ("<owner>/<name>") case-insensitively; also accepts a bare repo/dir name
 * as a convenience.
 */
export function findEstateRepo(fullName: string): EstateRepo | undefined {
  const needle = fullName.trim().toLowerCase();
  if (!needle) return undefined;
  return ESTATE.find(
    (r) =>
      r.repo.toLowerCase() === needle ||
      r.dir.toLowerCase() === needle ||
      `${ORG}/${r.dir}`.toLowerCase() === needle,
  );
}

/** Build the `x-access-token` clone URL for a repo given a short-lived token. */
export function tokenCloneUrl(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}
