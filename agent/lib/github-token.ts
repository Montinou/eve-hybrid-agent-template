import { createSign } from "node:crypto";
import { enabledRepos } from "./estate.ts";

// Lazy GitHub token provider — resolved per tool call, never at build time.
//
// The primary credential is the BYO GitHub App already used by the eve GitHub
// channel (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY): we sign an App JWT and
// exchange it for a short-lived installation access token, exactly as eve does
// internally. The channel authenticates WEBHOOKS with these envs; this module
// turns the same App into a GIT credential the dev-agent's sandbox sessions
// use to clone/fetch the estate (docs/03-github-channel.md §4).
//
// eve's own helper (`createGitHubInstallationToken`) is NOT importable outside
// the channel: the public `eve/channels/github` entry re-exports only the auth
// *types*, and the deep dist path is blocked by the package `exports` map
// (re-verified against eve 0.31.x: the entry exports only `githubChannel`,
// `defaultGitHubAuth`, `GitHubApiError` and `GITHUB_DEFAULT_EXCLUDED_DIFF_FILES`,
// and a deep import still fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`). So we
// replicate the mechanism here — RS256 JWT →
// POST /app/installations/{id}/access_tokens, discovering the installation id
// via GET /repos/{owner}/{repo}/installation.
//
// Fallback: a fine-grained PAT in GITHUB_TOKEN when the App envs are absent
// (a local-development convenience; the App is the production path).
//
// Consumption rule (gotcha 7 of the pattern): the resolved token is written to
// ~/.git-credentials inside the sandbox with the value passed through
// `session.run`'s ENV MAP — never in command text, never in prompts or logs —
// fresh per forked session, and deleted before any template snapshot is taken.
// See agent/lib/dev-agent.ts.

const GITHUB_API = "https://api.github.com";

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
// Keyed by installation id. Cleared implicitly when the process recycles.
const installationTokenCache = new Map<string, CachedToken>();

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Hosted platforms often escape PEM newlines; turn them back into real ones. */
function normalizePrivateKey(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/gu, "\n") : pem;
}

/** Mint a short-lived (10 min) RS256 GitHub App JWT. */
function createAppJwt(appId: string, privateKeyPem: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  // iat backdated 60s to absorb clock skew; exp at +540s stays inside
  // GitHub's 10-minute App-JWT maximum.
  const payload = { iat: nowSec - 60, exp: nowSec + 540, iss: appId };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(normalizePrivateKey(privateKeyPem), "base64url");
  return `${signingInput}.${signature}`;
}

const jsonHeaders = (jwt: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${jwt}`,
  "x-github-api-version": "2022-11-28",
});

/** Discover the App installation id for a repo the App is installed on. */
async function discoverInstallationId(
  jwt: string,
  owner: string,
  repo: string,
): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/installation`, {
    headers: jsonHeaders(jwt),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub App installation lookup failed for ${owner}/${repo}: HTTP ${res.status}. ` +
        `Confirm the App is installed on the repo (installation is per-repo and ` +
        `failure is silent — docs/03-github-channel.md §5). ${body.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as { id?: number };
  if (typeof data.id !== "number") {
    throw new Error(
      `GitHub App installation lookup for ${owner}/${repo} returned no numeric id.`,
    );
  }
  return String(data.id);
}

function parseExpiryMs(expiresAt: unknown): number {
  if (typeof expiresAt === "string") {
    const ms = Date.parse(expiresAt);
    if (Number.isFinite(ms)) return ms;
  }
  // GitHub installation tokens live ~1h; assume that if unparseable.
  return Date.now() + 60 * 60 * 1000;
}

async function mintInstallationToken(
  appId: string,
  privateKey: string,
  owner: string,
  repo: string,
): Promise<string> {
  const jwt = createAppJwt(appId, privateKey);
  const installationId =
    process.env.GITHUB_APP_INSTALLATION_ID?.trim() ||
    (await discoverInstallationId(jwt, owner, repo));

  const cached = installationTokenCache.get(installationId);
  if (cached && Date.now() < cached.expiresAtMs - 60_000) {
    return cached.token;
  }

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: jsonHeaders(jwt) },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub installation token exchange failed (installation ${installationId}): ` +
        `HTTP ${res.status}. ${body.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as { token?: string; expires_at?: string };
  if (typeof data.token !== "string") {
    throw new Error("GitHub installation token response did not include a token.");
  }
  installationTokenCache.set(installationId, {
    token: data.token,
    expiresAtMs: parseExpiryMs(data.expires_at),
  });
  return data.token;
}

/**
 * Resolve a GitHub credential usable for cloning/fetching the estate.
 *
 * Order: BYO GitHub App (primary) → fine-grained PAT `GITHUB_TOKEN` (fallback).
 * `repo` picks which repo's installation to look up when discovering the
 * installation id; it defaults to the first enabled estate repo. When the App
 * has ONE installation covering the whole estate (the common case), set
 * `GITHUB_APP_INSTALLATION_ID` to skip discovery entirely.
 */
export async function githubToken(repo?: {
  owner?: string;
  name?: string;
}): Promise<string> {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (appId && privateKey) {
    // Estate entries store the full "owner/name" GitHub repo name.
    const [fallbackOwner, fallbackName] = enabledRepos()[0]?.repo.split("/") ?? [];
    const owner = repo?.owner ?? fallbackOwner;
    const name = repo?.name ?? fallbackName;
    if (!owner || !name) {
      throw new Error(
        "githubToken: no repo to resolve the GitHub App installation from " +
          "(no enabled estate repos and no explicit repo passed).",
      );
    }
    return mintInstallationToken(appId, privateKey, owner, name);
  }

  const pat = process.env.GITHUB_TOKEN?.trim();
  if (pat) return pat;

  throw new Error(
    "No GitHub credential configured. Set the GitHub App envs " +
      "GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (primary), or GITHUB_TOKEN " +
      "(fine-grained PAT, fallback) as Sensitive env vars.",
  );
}
