// GitHub channel — BYO GitHub App wiring (docs/03-github-channel.md).
//
// No `credentials` block is passed to githubChannel: per the eve channel docs
// (node_modules/eve/docs/channels/github.mdx §"Bring your own GitHub App"),
// each credential field falls back to its env var — GITHUB_APP_ID,
// GITHUB_APP_PRIVATE_KEY (PEM) and GITHUB_WEBHOOK_SECRET — set on the
// deployment (mark the key and secret as Sensitive on Vercel). Vercel Connect
// was deliberately NOT used: it bills per token request, while eve does the
// JWT→installation-token exchange natively with the App's key, and the token
// never enters the sandbox.
//
// App configuration checklist (details in docs/01-prerequisites.md §4):
//  - Webhook URL: https://<deployment>/eve/v1/github — keep the Vercel project
//    (and thus this URL) stable across repo migrations; re-link, don't recreate.
//  - Event subscriptions: `pull_request` for PR turns, PLUS `issue_comment` and
//    `pull_request_review_comment` — eve requires the comment events for
//    mention turns and their absence fails SILENTLY.
//  - Installation is per-repo and failure is silent (gotcha #12): a repo the
//    App is not installed on never delivers a webhook and nothing tells you.
//    Install the App on a repo BEFORE enabling it in agent/lib/estate.ts.
//
// All dispatch logic lives in agent/lib/dispatch.ts as exported pure functions
// (returning null | { auth }) so it unit-tests without webhooks — this file
// only wires them up. Everything gate-able is gated there, in code, before any
// model runs; every piece of context tools will need is projected into
// auth.attributes there (tools can see nothing else).

import { githubChannel } from "eve/channels/github";
import { BOT_NAME, onCommentDispatch, onPullRequestDispatch } from "#lib/dispatch.ts";

// CUSTOMIZE: BOT_NAME — the App's mention handle users type in PR comments —
// is defined once in agent/lib/dispatch.ts (it also drives the command
// parser's mention check, so the two can never disagree). Change it there.
export default githubChannel({
  botName: BOT_NAME,
  onComment: onCommentDispatch,
  onPullRequest: onPullRequestDispatch,
});
