---
cron: "0 7 * * *"
---

Daily sandbox maintenance (07:00 UTC — Vercel evaluates schedule crons in UTC). Call the `warm_sandbox` tool exactly once, with no arguments, and then finish — do not deliver any message anywhere.

Why this exists: one call keeps BOTH sandbox lifecycles alive.

The dev-agent's harness template: a fresh warm keeps each run's incremental git sync small (instead of a growing delta as default branches drift), keeps the template snapshot away from its expiration (`TEMPLATE_SNAPSHOT_EXPIRATION_MS` — lapsing would force the next run to pay a full cold rebuild), and runs the built-in sweeps (stale prior-identity templates + orphaned fork snapshots) at least once a day even on days with no traffic.

Eve's own template — the sandbox behind the GitHub-channel checkout that `read_file`/`grep`/`glob` need: it is provisioned ONLY during a build, its snapshot expires on a timer, and eve's own repair path is disabled outside local development. When that snapshot lapses nothing brings it back, and every turn afterwards runs without a repo checkout until someone redeploys — silently, because the health endpoint keeps answering 200. This pass renews it before it can lapse, deletes dead session records (which otherwise pin their durable session to a sandbox that can no longer resume), and fires the deploy hook when the template is already gone. See docs/06-sandbox-lifecycle.md.

The tool reports the two halves separately (`warmed`/`detail` for the harness, `eve` for eve's own). Neither one failing stops the other.

**Weekly deep pass:** if your agent has a weekly schedule (a digest, a report), have it call `warm_sandbox` with `deep: true` as its first step. That additionally sweeps prior-identity eve templates, so a week of per-deploy template churn is collected in one place, and it guarantees the template is warm before the weekly job's own work starts.
