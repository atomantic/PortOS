<!--
  LI Proposal Playbook (#2763)

  Standing, human-authored rule set that distills what Layered Intelligence has
  learned about which proposals actually land vs. get rejected — so the reasoner
  stops proposing blindly. Loaded verbatim by server/services/layeredIntelligence.js
  as LI_PROPOSAL_PLAYBOOK and rendered as the `liPlaybook` block in every LI
  reasoning prompt (see buildPrompt). It ships in the source tree, NOT under
  data/prompts/ — it is code-versioned guidance, not a user-seeded/customizable
  stage prompt, so it needs no PROMPT_VERSIONS bump or setup-data migration.

  This is the a-priori guidance that applies BEFORE enough per-app outcome data
  accumulates. Where a live data block in the same prompt (liOutcomes /
  liProposalExecution) has real numbers for THIS app that contradict a general
  rule below, the live data wins. Absent that data, follow the playbook.

  Content is derived from LI's own outcome PATTERNS, never from any private
  record. Keep it generic — no real issue titles, slugs, hostnames, or user data.
-->

# LI Proposal Playbook

You (the reasoner) file blindly by default: you propose work without checking how
your past proposals fared, which produces a low merge rate and repeated
NOT_PLANNED rejections. This playbook is your correction. Treat it as a hard
constraint on **which scope**, **which kind of work**, and **whether it aligns
with goals** — applied before you commit to any proposal.

## 1. Scope Selection Guide

Not all proposal scopes land equally. Prioritize scopes that historically merge;
require extra justification for scopes that historically get rejected.

- **Prefer `loop-meta`** (PortOS install only). Improvements to the LI loop
  itself — better dedup, better calibration, clearer prompts, fixing a failure
  mode you can see in your own reports — merge at a high rate because they are
  concrete, verifiable, and self-contained.
- **Prefer `app-data-gap`.** Adding the telemetry / metrics / instrumentation
  needed to reason well (e.g. a missing METRICS.md, an unmeasured KPI) lands
  reliably: it is unambiguous, low-risk, and unblocks future higher-value work.
- **De-prioritize `app-improvement` unless alignment is explicit.** A generic
  "improve the app" proposal without a clear tie to a stated goal, a measured
  gap, or committed backlog is the single largest source of rejections. Only
  file it when you can name the specific goal it serves and the signal that
  says it is the highest-value item now.
- **`portos-self`** (PortOS install only): scoped, verifiable self-improvements
  to PortOS as an app — hold to the same bar as `app-improvement`.

If nothing clears this bar, return `proposal: null`. Filing nothing is a
legitimate, and often the correct, outcome.

## 2. Success Pattern Catalog

Proposals that merge tend to share these traits — bias toward them:

- **Concrete and bounded.** A single, well-scoped change a coding agent can
  finish end-to-end, not an open-ended "rework X".
- **Grounded in a real signal.** Cites a measured gap, a goal, a failing metric,
  or a self-report block above — not a hunch.
- **Non-duplicative.** Does not overlap the already-open issues or the committed
  backlog (`plannedWork`). Reuse an existing slug only for genuinely the same work.
- **Fills a data/telemetry gap** so future runs can reason better (the classic
  high-merge `app-data-gap`).
- **Fixes a loop failure you can see** in `liOutcomes` / `liProposalExecution` /
  `liScopeAwareness` (the classic high-merge `loop-meta`).

## 3. Rejection Pattern Catalog

Proposals get closed for recurring reasons. Before filing, check that yours is
not one of these:

- **NOT_PLANNED = roadmap conflict.** A NOT_PLANNED close almost always means the
  work runs against the product's direction, not that it was poorly written.
  **Check the goals and committed backlog FIRST** — if the proposal is not
  clearly on-roadmap (or is explicitly out of scope / a non-goal), do not file it.
- **Duplicate / already-planned.** Overlaps an open issue or committed backlog
  item. Cross-reference `plannedWork` and the open-issue list before filing.
- **Too vague / unbounded.** No clear acceptance criteria; a human cannot tell
  when it is done. Narrow it or drop it.
- **Speculative "nice to have"** with no goal tie and no measured need. Costs the
  user triage time and lowers your merge rate further.
- **Maps to a chronically-failing execution domain** (see the next section).

## 4. Task Type Selection Rules

An LI proposal is later EXECUTED as a coding-agent task. Proposing work that maps
to a task type that reliably FAILS to complete is systematic waste, even when the
idea is good.

- **Avoid your own worst scope.** Self-improvement work that maps to LI's own
  reasoning-run task type (`self-improve:layered-intelligence`) has historically
  had ~0% completion. Do not propose more of it while your own execution is
  degraded — the highest-value loop-meta fix is usually the one that repairs
  the failure mode itself, framed so it is genuinely finishable.
- **Avoid chronically-failing types** surfaced in `liScopeAwareness` /
  `liProposalExecution` (e.g. types sitting at 0% completion). If the live block
  above lists a low-completion type, treat a proposal resembling it as needing a
  narrower scope or a different framing.
- **Prefer reliably-completed types.** Work that resembles `plan-task`,
  `test-coverage`, or `performance` tends to complete near-reliably — bias
  proposals toward shapes an agent actually finishes.
- **When a live report and this list disagree,** the live per-app report wins:
  it is a direct record; this list is the a-priori default before that data exists.

## 5. Goal Alignment Check

Run this check before committing to any proposal. If it fails, return
`proposal: null`.

1. **Name the goal it serves.** Point to a specific stated goal / purpose of the
   app. For the PortOS install, that is a Core Goal in GOALS.md (e.g.
   Self-Improving Intelligence, Autonomous AI Orchestration, Creative Production).
   If you cannot name one, it is probably `app-improvement` noise — drop it.
2. **Check it is not a non-goal.** Do not propose work the project has explicitly
   ruled out (for PortOS: multi-user auth, public-internet hardening, ORM/query
   builders, cloud hosting — these are documented non-goals and NOT_PLANNED
   magnets).
3. **Confirm it is not already committed.** Cross-reference `plannedWork` and the
   open-issue list — on-roadmap work already in flight is a duplicate, not a
   proposal.
4. **Prefer the highest-leverage goal.** Among candidates, favor the one that
   unblocks or compounds future work (data gaps, loop-meta fixes) over a
   one-off improvement.
