#!/usr/bin/env node
/**
 * Drive the deployed QA agent from a terminal through the eve channel.
 *
 * The eve channel (`/eve/v1/session*`) is enabled by default, so this needs no
 * server-side change — only a credential the channel's auth accepts. The
 * default policy is `[vercelOidc(), localDev()]`, so from a laptop that means a
 * Vercel OIDC token, which is what `--refresh` fetches.
 *
 * Usage:
 *   node scripts/orchestrate.mjs "review the changes on this branch"
 *   node scripts/orchestrate.mjs --refresh "..."     # pull a fresh OIDC token first
 *   node scripts/orchestrate.mjs --resume "..."      # follow up on the last session
 *   node scripts/orchestrate.mjs --attach            # re-watch the last session's turn
 *   node scripts/orchestrate.mjs --cancel            # stop the last session's turn
 *
 * Credential resolution, first hit wins:
 *   1. EVE_TOKEN — set this to the channel's API key to authenticate as an
 *      API client instead of a Vercel principal. Unlike an OIDC token it does
 *      not expire, so --refresh is unnecessary:
 *        EVE_TOKEN=$AGENT_API_KEY node scripts/orchestrate.mjs "/status"
 *      The same key works from any HTTP client:
 *        curl -X POST "$AGENT_URL/eve/v1/session" \
 *          -H "authorization: Bearer $AGENT_API_KEY" \
 *          -H 'content-type: application/json' \
 *          -d '{"message":"/triage some-test.spec.ts"}'
 *   2. VERCEL_OIDC_TOKEN (environment)
 *   3. VERCEL_OIDC_TOKEN in .env.local
 *
 * Overrides: EVE_AGENT_URL (target deployment), VERCEL_CONFIG_DIR (which Vercel
 * account --refresh authenticates as).
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * CUSTOMIZE: your agent's production deployment URL, or leave it unset and
 * always pass EVE_AGENT_URL. There is no sensible default for a template.
 */
const DEFAULT_AGENT_URL = process.env.EVE_AGENT_URL ?? ""

/** Where the last session's handles are cached so `--resume` needs no arguments. */
const SESSION_CACHE = path.join(REPO_ROOT, ".eve-session.json")

/**
 * How many times to re-open the stream when the connection ends before the turn
 * settles. A dev-agent turn runs for minutes across several serverless response
 * lifetimes, so this needs enough headroom to outlast one.
 */
const STREAM_MAX_RECONNECTS = 40
const STREAM_RECONNECT_DELAY_MS = 2000

const agentUrl = (process.env.EVE_AGENT_URL ?? DEFAULT_AGENT_URL).replace(/\/$/, "")
if (!agentUrl) {
  console.error("\nSet EVE_AGENT_URL to your deployment, e.g. https://<deployment>.vercel.app\n")
  process.exit(1)
}

function readEnvFile(file) {
  if (!existsSync(file)) return {}
  const out = {}
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
  return out
}

/** Seconds until a JWT's `exp`, or null when it can't be read. */
function secondsUntilExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    return typeof payload.exp === "number" ? payload.exp - Math.floor(Date.now() / 1000) : null
  } catch {
    return null
  }
}

/**
 * Pull a fresh OIDC token. `vercel env pull` mints one on every download, so a
 * throwaway target keeps .env.local (which holds values not stored in Vercel)
 * untouched.
 */
function refreshOidcToken() {
  const target = path.join(mkdtempSync(path.join(tmpdir(), "eve-oidc-")), "env")
  const args = ["env", "pull", target, "--yes"]
  if (process.env.VERCEL_CONFIG_DIR) args.unshift("--global-config", process.env.VERCEL_CONFIG_DIR)
  execFileSync("vercel", args, { cwd: REPO_ROOT, stdio: "pipe" })
  const token = readEnvFile(target).VERCEL_OIDC_TOKEN
  if (!token) throw new Error("vercel env pull returned no VERCEL_OIDC_TOKEN")
  return token
}

function resolveToken({ refresh }) {
  if (refresh) return refreshOidcToken()

  const token =
    process.env.EVE_TOKEN ||
    process.env.VERCEL_OIDC_TOKEN ||
    readEnvFile(path.join(REPO_ROOT, ".env.local")).VERCEL_OIDC_TOKEN

  if (!token) {
    fail(
      "No credential found.\n" +
        "Set EVE_TOKEN, or re-run with --refresh to mint a Vercel OIDC token.",
    )
  }

  const ttl = secondsUntilExpiry(token)
  if (ttl !== null && ttl <= 0) {
    fail(
      `The OIDC token expired ${Math.abs(Math.round(ttl / 3600))}h ago.\n` +
        "Re-run with --refresh to mint a new one.",
    )
  }
  return token
}

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

function loadSession() {
  if (!existsSync(SESSION_CACHE)) {
    fail("No cached session. Start one by running without --resume/--cancel.")
  }
  return JSON.parse(readFileSync(SESSION_CACHE, "utf8"))
}

/**
 * Vercel Deployment Protection sits in front of preview deployments, so
 * validating a branch before it reaches production needs the project's
 * automation bypass secret alongside the channel credential. Set
 * EVE_BYPASS_TOKEN to a Protection Bypass for Automation secret; production
 * runs leave it unset and nothing changes.
 */
function protectionHeaders() {
  const bypass = process.env.EVE_BYPASS_TOKEN?.trim()
  return bypass ? { "x-vercel-protection-bypass": bypass } : {}
}

async function post(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...protectionHeaders(),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) fail(`HTTP ${res.status} from ${url}\n${text}`)
  return text ? JSON.parse(text) : {}
}

/** Terminal events: the turn settled and there is nothing more to wait for. */
const TERMINAL = new Set(["session.waiting", "session.completed", "session.failed"])

/**
 * Events that mean the turn did NOT do what it was asked. Tracked because this
 * script is a CI entry point (.github/workflows/warm-after-deploy.yml): a job
 * that prints `[turn.failed]` and then exits 0 reports a green deploy over a
 * warm that never happened, which is the exact failure mode that workflow
 * exists to prevent.
 */
const FAILURE_EVENTS = new Set(["turn.failed", "session.failed"])

/**
 * Read one HTTP stream connection, rendering events, until it ends or a terminal
 * event arrives. Returns where the cursor got to and whether it settled.
 */
async function readStreamOnce(sessionId, token, startIndex) {
  const res = await fetch(
    `${agentUrl}/eve/v1/session/${sessionId}/stream?startIndex=${startIndex}`,
    { headers: { authorization: `Bearer ${token}`, ...protectionHeaders() } },
  )
  if (!res.ok || !res.body) fail(`Stream failed: HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let failed = false
  let index = startIndex

  const render = ({ type, data }) => {
    switch (type) {
      case "message.appended":
        process.stdout.write(data?.messageDelta ?? "")
        break
      case "tool.started":
        console.log(`\n  → tool: ${data?.toolName ?? "?"}`)
        break
      case "tool.completed":
        console.log(`  ← tool done: ${data?.toolName ?? "?"}`)
        break
      case "turn.failed":
        console.error(`\n[turn.failed] ${data?.code}: ${data?.message}`)
        break
      case "session.waiting":
        break
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { streamIndex: index, settled: false, failed }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      index += 1
      render(event)
      if (FAILURE_EVENTS.has(event.type)) failed = true
      if (TERMINAL.has(event.type)) {
        await reader.cancel().catch(() => {})
        return { streamIndex: index, settled: true, failed }
      }
    }
  }
}

/**
 * Render the event stream until the session parks or ends, reconnecting from the
 * cursor whenever the HTTP connection drops first.
 *
 * Two properties of the durable stream make the cursor load-bearing:
 *
 * 1. It replays from the beginning by default, so a follow-up MUST resume from
 *    where the previous turn ended — otherwise the first `session.waiting` seen
 *    is the PREVIOUS turn's, and the run looks like it answered instantly with
 *    stale text.
 * 2. A single connection is not guaranteed to outlive the turn. Long turns (a
 *    triage boots a sandbox and runs for minutes) outlast the serverless
 *    response, which ends the body with no terminal event. Without reconnecting
 *    the script exits silently while the turn is still running server-side —
 *    indistinguishable from an agent that replied with nothing.
 */
async function streamSession(sessionId, token, startIndex = 0) {
  let cursor = startIndex
  let failed = false

  for (let attempt = 0; attempt < STREAM_MAX_RECONNECTS; attempt += 1) {
    const result = await readStreamOnce(sessionId, token, cursor)
    cursor = result.streamIndex
    failed = failed || result.failed
    if (result.settled) return { streamIndex: cursor, failed }
    // Reconnect. A turn mid-tool-call emits nothing for a while, so a dropped
    // connection that yielded no new events is normal, not a reason to stop.
    await new Promise((r) => setTimeout(r, STREAM_RECONNECT_DELAY_MS))
  }

  console.error(
    `\n[stream] gave up after ${STREAM_MAX_RECONNECTS} reconnects; the turn may still be running.` +
      `\n[stream] re-attach with: node scripts/orchestrate.mjs --attach`,
  )
  // Giving up is a failure for a caller that needs an answer (CI): the turn's
  // outcome is unknown, and "unknown" must not read as "fine".
  return { streamIndex: cursor, failed: true }
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    if (i === -1) return false
    argv.splice(i, 1)
    return true
  }

  const refresh = flag("--refresh")
  const resume = flag("--resume")
  const cancel = flag("--cancel")
  const attach = flag("--attach")
  const message = argv.join(" ").trim()

  const token = resolveToken({ refresh })

  if (cancel) {
    const { sessionId } = loadSession()
    const out = await post(`${agentUrl}/eve/v1/session/${sessionId}/cancel`, token, {})
    console.log(`cancel: ${out.status ?? "ok"} (${sessionId})`)
    return
  }

  // Re-attach sends NO message: it watches a turn already running, which is how
  // you recover a long dev-agent run after the local process died or gave up.
  if (attach) {
    const cached = loadSession()
    console.log(`⇄ ${cached.sessionId} (from event ${cached.streamIndex ?? 0})\n`)
    const { streamIndex, failed } = await streamSession(
      cached.sessionId,
      token,
      cached.streamIndex ?? 0,
    )
    writeFileSync(
      SESSION_CACHE,
      JSON.stringify({ sessionId: cached.sessionId, streamIndex }, null, 2),
    )
    if (failed) process.exitCode = 1
    return
  }

  if (!message) fail('Nothing to send. Pass a message: orchestrate.mjs "…"')

  let sessionId
  let startIndex = 0
  if (resume) {
    const cached = loadSession()
    sessionId = cached.sessionId
    startIndex = cached.streamIndex ?? 0
    // eve sessions are plain ID-addressed (no continuation tokens):
    // the follow-up body carries only the message, and an unknown or terminal
    // session answers 409 `session_not_active` instead of silently starting a
    // replacement (channels/eve.mdx §"Start and continue a session").
    await post(`${agentUrl}/eve/v1/session/${sessionId}`, token, { message })
    console.log(`↻ ${sessionId}\n`)
  } else {
    const started = await post(`${agentUrl}/eve/v1/session`, token, { message })
    sessionId = started.sessionId
    console.log(`▶ ${sessionId}\n`)
  }

  const { streamIndex, failed } = await streamSession(sessionId, token, startIndex)
  writeFileSync(SESSION_CACHE, JSON.stringify({ sessionId, streamIndex }, null, 2))
  console.log(`\n\nsession: ${sessionId}  (--resume to continue, --cancel to stop)`)
  if (failed) process.exitCode = 1
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)))
