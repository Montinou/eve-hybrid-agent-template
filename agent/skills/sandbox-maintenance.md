---
description: Use when asked to warm, rebuild or clean the dev-agent sandbox template, or when a dev task fails with sandbox/snapshot errors.
---

# Sandbox template maintenance

The nested dev-agent forks a pre-built TEMPLATE sandbox per run. A cold
template build (CLI install + estate clones + installs) eats most of a step
budget, so the template is warmed OUT of band and the runs only fork it.

## Workflow

1. **Warm on demand:** call `warm_sandbox` when asked to warm/refresh, after
   changing the enabled estate, or after a run failed with template/snapshot
   errors. It is idempotent: an up-to-date template returns quickly.
2. **Scheduled warm:** `schedules/template-maintenance.md` re-warms daily so
   the first run of the day never pays the cold build. Do not remove it.
3. **Recipe changes invalidate by construction:** the template's identity
   hashes the enabled repo+branch set AND `RECIPE_VERSION`. Changing clones,
   installs or sandbox resources requires bumping `RECIPE_VERSION` in
   `lib/dev-agent.ts` — the next warm rebuilds automatically.
4. **Steady-state inventory** (report deviations, never mass-delete):
   1 template sandbox + at most 2 template snapshots + nothing else
   lingering. Sweeps run inside the warm itself (`lib/template-sweep.ts`).

## Failure interpretation

- `snapshot not found` / fork 400s → template evicted or poisoned: warm once,
  then retry the dev task on the NEXT turn (never in the same turn).
- Repeated `createSession` 400s with the same session id → orphaned sandbox
  under that name; the sweep in the next warm clears it.
- Timeouts during warm → report `partial` honestly; the schedule will finish
  the job, or the user can call warm again.
