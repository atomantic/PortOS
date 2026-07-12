# The `METRICS.md` convention

`METRICS.md` is a repo-root file a **managed app** adds to document its own
success metrics — how the app measures whether it is doing its job — so that
agents can evaluate the app against its own goals and purpose instead of guessing.

It is the app-performance counterpart to `GOALS.md`: `GOALS.md` says *what the app
is trying to achieve*; `METRICS.md` says *how you know whether it's achieving it,
and where those numbers live*.

## Why it exists

PortOS's [Layered Intelligence loop](./plans/2026-07-07-layered-intelligence-loop.md)
perpetually reviews each managed app and files one high-value improvement proposal
per run. To reason well it needs to evaluate the app against **its own**
performance — user success, product KPIs, production telemetry — not against how
reliably PortOS's coding agents happen to change it.

Most of that data lives outside the repo: a production database, an external
telemetry/analytics service, a metrics dashboard, an events pipeline. An agent has
no way to discover those unless the repo tells it where they are and how to read
them. `METRICS.md` is that map.

## Who reads it

- **Layered Intelligence** gathers repo-root `METRICS.md` as the `appMetrics`
  source (on by default for every app) and folds it into the reasoning prompt.
  When an app has no `METRICS.md`, the loop is nudged to propose adding one as an
  `app-data-gap` — so the app becomes measurable over time.
- **Coding agents** picking up a filed proposal can follow the same doc to fetch
  current numbers before/after a change and judge whether it moved the metric.
- **Humans** get a single, honest description of what "healthy" means for the app.

## What to put in it

Keep it concise and specific. A good `METRICS.md` answers:

1. **What does success mean for this app?** The 3–7 metrics that actually matter,
   each tied back to a goal in `GOALS.md`.
2. **Where does each metric live?** Production database, telemetry service,
   dashboard, or log/event source — named by role, with a non-secret locator.
3. **How does an agent read the current value?** A query, an endpoint, or a CLI
   command it can run — parameterized by environment variables, never with
   embedded credentials.
4. **What's a good/bad value?** A target, threshold, or recent baseline so a
   reader can tell whether the number is healthy.

### Suggested shape

```markdown
# Metrics — example-app

How we measure whether example-app is succeeding. See GOALS.md for the goals
these metrics serve.

## Key metrics

| Metric | Why it matters (goal) | Source | Target |
|--------|-----------------------|--------|--------|
| Weekly active users | Reach — "help more people do X" | production DB | ↑ week over week |
| Task completion rate | Core value — users finish the flow | events pipeline | ≥ 80% |
| p95 request latency | Quality of service | telemetry service | < 400 ms |
| 7-day retention | Stickiness | production DB | ≥ 45% |

## Where the data lives

- **Production database** — read-only analytics replica. Connection string in the
  `ANALYTICS_DB_URL` environment variable (never commit it). Read-only user only.
- **Telemetry / analytics service** — dashboard at the URL in `TELEMETRY_URL`;
  API token in `TELEMETRY_TOKEN`.

## How to read current values (for agents)

Run these from the repo with the environment loaded. They print current numbers;
they do not modify anything.

- Weekly active users:
  `psql "$ANALYTICS_DB_URL" -c "select count(distinct user_id) from events where ts > now() - interval '7 days';"`
- Task completion rate: `GET $TELEMETRY_URL/api/metrics/completion-rate` with
  `Authorization: Bearer $TELEMETRY_TOKEN`.

## Notes

- All queries above hit a **read-only** replica/endpoint. Do not point them at a
  primary or run anything that writes.
```

## Rules

- **Repo-root only.** Layered Intelligence reads `METRICS.md` at the repository
  root of the app (same place it reads `GOALS.md` / `PLAN.md` / `HEALTH_REPORT.md`).
- **No secrets.** Reference credentials by environment variable or secret-manager
  key. Never paste a real connection string, password, token, or private hostname
  into the file — it is committed and shared like any other source.
- **Read-only access.** Every query or endpoint you document for agents must be a
  read-only path. An agent should be able to *observe* the metric, never mutate
  production data to measure it.
- **Keep it current.** Stale targets are worse than none — update the file when the
  metrics or their sources change.

## Feeding live numbers into the loop

`METRICS.md` documents *where* the metrics are and *how* to read them. If you also
want current values injected into each Layered Intelligence run automatically, add
a **custom source** in the app's Layered Intelligence config (Edit App →
Intelligence):

- a **command** source that runs one of the read-only queries above, or
- an **http** source that fetches a metrics endpoint.

That keeps `METRICS.md` as the human-readable map while the loop reasons over fresh
numbers each run.
