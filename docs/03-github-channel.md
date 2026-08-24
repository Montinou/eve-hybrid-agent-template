# 03 — Phase 2: GitHub channel, deterministic dispatch, and the attributes bridge

Goal of this phase: real GitHub webhooks reach the deployed agent, dispatch decides deterministically which events become turns, and every piece of context the tools will later need is projected onto the session at dispatch time. Verified by a live probe at the end.

Prerequisites: phase 1 complete (health 200); the GitHub App from [docs/01-prerequisites.md](01-prerequisites.md) §4 created and **installed on your probe repo**.

Files in play: [`agent/channels/github.ts`](../agent/channels/github.ts), [`agent/lib/dispatch.ts`](../agent/lib/dispatch.ts), [`agent/lib/estate.ts`](../agent/lib/estate.ts), [`agent/lib/github-token.ts`](../agent/lib/github-token.ts).

## 1. BYO App: three env vars, no credentials block

The channel file passes **no `credentials` block** to `githubChannel` — per eve's GitHub channel docs (`node_modules/eve/docs/channels/github.mdx` §"Bring your own GitHub App"), each field falls back to its env var:

```bash
vercel env add GITHUB_APP_ID production            # App id (number as string)
vercel env add GITHUB_APP_PRIVATE_KEY production   # full PEM — Sensitive
vercel env add GITHUB_WEBHOOK_SECRET production    # Sensitive
```

Notes:

- **PEM newlines:** hosted platforms often store multiline values `\n`-escaped. [`agent/lib/github-token.ts`](../agent/lib/github-token.ts) normalizes escaped newlines back to real ones, so paste the PEM either way.
- **Why not Vercel Connect?** Connect can manage the App for you, but it bills per token request; eve does the JWT→installation-token exchange natively with your App's key, and the token never enters the sandbox. BYO is cheaper and keeps you in control of permissions.
- Update the App's **Webhook URL** to the real deployment now: `https://<deployment>/eve/v1/github`. Keep the Vercel project (and thus this URL) stable over time — re-link the repo rather than recreating the project, or you'll be editing App settings on every migration.

Set the bot name in `agent/lib/dispatch.ts` (the `BOT_NAME` constant with its `// CUSTOMIZE:` marker, overridable via `GITHUB_APP_SLUG`) to your App's mention handle — it drives both eve's mention dispatch and the command parser.

## 2. Deterministic dispatch: pure functions, not model judgment

Inbound hooks return `{ auth }` to start a turn, or `null` to ignore the event. The template's rule: **everything gate-able is gated here, in code, before any model runs.** The two handlers are exported, (mostly) pure functions in [`agent/lib/dispatch.ts`](../agent/lib/dispatch.ts), so they unit-test without webhooks ([`agent/lib/dispatch.test.ts`](../agent/lib/dispatch.test.ts)); [`agent/channels/github.ts`](../agent/channels/github.ts) just wires them up:

```ts
export default githubChannel({
  botName: BOT_NAME,
  onComment: onCommentDispatch,
  onPullRequest: onPullRequestDispatch,
});
```

Gating rules the template ships (adapt at the `// CUSTOMIZE:` markers):

- **`onPullRequest`** returns `null` unless the repo resolves through the estate registry ([`agent/lib/estate.ts`](../agent/lib/estate.ts)) to an *enabled* entry AND the action is `opened`/`synchronize`. Resolving through the estate (case-insensitive, accepts bare names) means gating **fails closed** for unknown repos — an App installed org-wide can deliver events from repos you never intended to serve.
- **`onComment`** returns `null` unless (a) the comment is on a PR, (b) the body parses as a `@bot` command (a dedicated, unit-tested parser — see `agent/lib/dispatch.ts` for the exact grammar), and (c) the repo is enabled in the estate. **Untagged comments must NOT create sessions** — every stray comment on a busy repo would otherwise burn a turn.

Why deterministic? Cost and auditability. The cheap model never sees events that don't matter, a dispatch bug is a failing unit test rather than a "the model felt like it" mystery, and the security boundary starts here: only events matching an explicit code path get any further.

## 3. The attributes bridge — the ONLY context tools can see

This is the least obvious and most load-bearing part of the channel. **Tools see nothing channel-specific.** A tool's context has no `ctx.github`, no webhook payload, no PR object. The one deterministic bridge from the webhook to a tool is the `SessionAuthContext.attributes` map that your dispatch handler attaches, read back inside tools via:

```ts
ctx.session.auth.current.attributes
```

Consequence: **project everything tools will need, at dispatch time.** The template's dispatch builds auth like this (see `agent/lib/dispatch.ts`):

```ts
function buildPullRequestAuth(ctx, pr) {
  const base = defaultGitHubAuth(ctx); // repository, pull_request_number, user_login
  return {
    ...base,
    attributes: {
      ...base.attributes,
      ...prAttributesFromRaw(pr.raw, pr.headSha), // base_sha, head_sha,
      // merge_commit_sha, branch, pr_author, changed_files (stringified)
    },
  };
}
```

Rules learned the hard way (all encoded in the template — keep them when customizing):

1. **`defaultGitHubAuth` is not enough.** It provides `repository`, `pull_request_number`, `user_login` — but NOT shas or branch. Read those from the webhook's raw payload (`pr.raw` on PR events).
2. **Comment events don't carry PR data.** The comment webhook payload lacks head/base sha and branch, so the comment path fetches the PR via `ctx.github.request` (installation-token auth, per the channel docs' "Arbitrary API calls"). **Fail-soft:** if the fetch fails, dispatch anyway *without* PR attributes — capability tools then return their documented "no PR context" result instead of stranding the turn.
3. **Attribute values are strings** (`Record<string, string | string[]>`). Stringify numbers at dispatch; parse them back in one dedicated module, never ad hoc in tools.
4. **Omit absent fields; never invent values.** `merge_commit_sha` is legitimately `null` early in a PR's life — an omitted attribute reads back as "absent", a fabricated one poisons downstream joins.
5. **Set the command attribute LAST** in the spread, so a raw-payload field of the same name can never clobber it. This attribute does double duty: it drives the per-turn dynamic model routing in [`agent/agent.ts`](../agent/agent.ts) (command turns → `COMMAND_MODEL`) *and* the orchestrator's turn-mode branching in [`agent/instructions.md`](../agent/instructions.md). See [docs/04-orchestrator.md](04-orchestrator.md).

If you add a capability later and it needs a new piece of webhook context, the change starts *here*, in dispatch — not in the tool.

## 4. Installation token minting (git credentials for the sandbox)

The channel authenticates *webhooks*; the dev-agent needs a separate *git credential* to clone and fetch inside the sandbox. eve's internal token helper is not importable (the package `exports` map blocks the deep path), so [`agent/lib/github-token.ts`](../agent/lib/github-token.ts) replicates the mechanism:

1. Sign a short-lived RS256 App JWT (`iss` = App id, `iat` now−60s, `exp` now+540s).
2. Discover the installation id via `GET /repos/{owner}/{repo}/installation` — or skip discovery with `GITHUB_APP_INSTALLATION_ID`.
3. `POST /app/installations/{id}/access_tokens` → ~1h token, cached per installation id with a 60s expiry margin.
4. Fallback: a fine-grained PAT in `GITHUB_TOKEN` when App envs are absent.

How the dev-agent consumes it (details in [docs/05-dev-agent.md](05-dev-agent.md)): the token is written to `~/.git-credentials` inside the sandbox with the value passed through `session.run`'s **env map** — never in command text — fresh per forked session, and deleted before any template snapshot is taken.

## 5. The per-repo installation gotcha (gotcha #12)

> **A repo the App is not installed on never delivers a webhook, and nothing tells you.** No error in the App's "Recent Deliveries", no log line anywhere — the event simply doesn't exist. Validated empirically: a probe comment on a non-installed repo produced nothing; the same probe on an installed control repo delivered in ~2 seconds.

So whenever a turn "mysteriously doesn't happen", check in this order:

1. **App installed on that repo?** GitHub → Organization settings → GitHub Apps → your App → *Repository access*. This is also step 1 of the enable-a-repo checklist in [docs/09-customization-checklist.md](09-customization-checklist.md) — install FIRST, then flip the estate flag.
2. **Event type subscribed?** `issue_comment` and `pull_request_review_comment` are required for mention turns and are easy to miss.
3. **Delivery arrived but dispatch returned `null`?** Check the App's *Advanced → Recent Deliveries* (response code 200 = eve received and ignored it) and re-read your gates: estate enabled flag, action filter, command parse.

## 6. Probe validation

With envs set and the webhook URL updated, deploy and probe against a repo the App is installed on:

```bash
vercel deploy --prod    # wait ~100s for the build
```

1. **Delivery path:** open (or push to) a test PR on the probe repo. In the App's *Recent Deliveries*, confirm a `pull_request` delivery with response **200** from `/eve/v1/github`.
2. **Dispatch path:** comment on the PR:

   ```text
   @{{BOT_NAME}} /task hello
   ```

   Expect an `eyes` reaction on the comment (the channel adds it when a turn starts), then a reply comment from the bot. The reply's *content* may be a fail-soft "capability not configured yet" — that's fine; capabilities arrive in phase 4. What you are proving here is webhook → dispatch → turn → comment.
3. **Negative path:** post an *untagged* comment on the same PR. Confirm NO reaction and NO session (check the delivery got a 200 but no turn followed) — untagged comments must not create sessions.
4. **Attributes path:** once phase 4's tools exist, they will read the PR attributes; for now you can assert them in unit tests:

   ```bash
   pnpm test -- dispatch
   ```

## Verification

Do not proceed to phase 3 until every box checks:

- [ ] `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (Sensitive), `GITHUB_WEBHOOK_SECRET` (Sensitive) set on the Vercel project.
- [ ] App webhook URL = `https://<deployment>/eve/v1/github`; events include `pull_request`, `issue_comment`, `pull_request_review_comment`.
- [ ] App installed on the probe repo (checked explicitly — silence is not evidence).
- [ ] `pnpm test` passes, including the dispatch unit tests.
- [ ] Probe PR event: delivery 200 in Recent Deliveries.
## Turn policy: queue, don't steer

`githubChannel` is configured with **`turnPolicy: "queue"`** and
**`progress: { reactions: true }`**. Both are deliberate.

Since eve 0.33 the channel default is `"steer"`: a message arriving during an
active turn **cancels that turn** and starts a replacement, and *"completed
side effects are not rolled back"*. For an agent whose turns hold an 8-vCPU
sandbox for minutes, that is destructive — a push landing mid-run abandons a
booted fork and throws away work already paid for. `"queue"` makes the active
turn finish first.

The 👀 reaction is the other half of the same problem. A command that boots a
sandbox shows nothing on the PR for minutes; without an acknowledgement people
assume it was ignored and post it again, and under `"queue"` that second
command is not a no-op — it is a second expensive run, waiting its turn. eve
adds the reaction as the turn begins, before any of that work starts. It is the
default, but a channel with its own `onComment` replaces the default mention
gate, so declare it rather than inherit it.

**Scope:** sessions are per conversation — one durable session per PR, issue,
or review thread. So `"queue"` serializes turns *within one thread only*; other
PRs keep running concurrently. Within one PR, comment turns and PR-event turns
share the session, which is exactly why the model resolver in `agent/agent.ts`
is keyed on `turn.started` rather than `session.started`.

- [ ] Probe `@bot` comment: `eyes` reaction + bot reply comment.
- [ ] Untagged comment: no reaction, no session.

Next: [docs/04-orchestrator.md](04-orchestrator.md) — the orchestrator prompt, the security boundary, and per-turn model routing.
