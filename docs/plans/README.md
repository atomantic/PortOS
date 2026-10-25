# Design Plans

This directory archives the design plans behind significant PortOS features — a
record of *how* and *why* each feature was designed, captured before
implementation.

- One file per plan, named `YYYY-MM-DD-<slug>.md` (date of approval).
- Newest plans sort last by their date prefix.
- Each plan typically opens with a **Context** section (the problem and intended
  outcome), then the architecture, data model, and a verification section.

Index of plans other docs point at:

- [2026-10-18 — local-first merge gate](./2026-10-18-ci-local-first-merge-gate.md):
  the CI/test latency audit and the six changes behind the test memo, the
  resource suites in pregate, and the pregate attestation CI honors.

- [2026-10-20 — CoS task queue to PostgreSQL](./2026-10-20-cos-task-queue-to-postgres.md):
  why `TASKS.md` / `COS-TASKS.md` outgrew their files, the single `cos_tasks`
  table that replaced them (and the interim archive), and the migrations that
  bring existing installs to it.

These are point-in-time design records, not living docs — they are not updated
to track implementation drift. For current behavior, see the code, `CLAUDE.md`,
and the topic docs elsewhere under `docs/`.

- [2026-10-25 — creative catalog primitives](./2026-10-25-creative-primitives.md):
  explicit universe ownership, shared editing, usage labels and independent forks
  over the existing catalog model, with staged legacy ambiguity.

- [2026-10-25 — Casting detail performance](./2026-10-25-casting-detail-performance.md):
  measured payload/query scaling, lean first render and lazy secondary reads,
  with explicit limits on live performance claims.

- [2026-10-25 — shared character workspace](./2026-10-25-character-workspace.md):
  rich shared cards and one compact canonical editor with explicit drafts,
  bounded context reads and atomic locks.
