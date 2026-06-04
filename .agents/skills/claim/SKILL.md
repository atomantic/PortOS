---
name: claim
description: Claim the next unclaimed PLAN.md item (or, with --issues, an open GitHub issue) by its ID, do the work in an isolated worktree, ship a PR, merge it, and clean up. Use when the user asks Codex to claim work, run claim, pick the next PLAN.md item or GitHub issue, or implement a specific slug / issue number.
argument-hint: "[<slug|#issue>] [--issues] [--review-with=<copilot|codex|agy|claude>[,…]] [--no-review]"
---

# Claim Skill — Pick the next PLAN.md item (or GitHub issue) and ship it

This skill and the `/claim` slash command run the **same workflow**. To keep the two from drifting — `--issues` mode, the cross-machine in-progress marker, the worktree machinery, the review loop — there is a single source of truth:

> **The authoritative, always-current procedure lives in [`.claude/commands/claim.md`](../../../.claude/commands/claim.md) (repo-root `/.claude/commands/claim.md`). Read that file now and execute every phase in it — Phase 1 (Pick) through Phase 7 (Clean up), in whichever mode applies (PLAN.md by default, GitHub issues with `--issues`).**

Everything below is *only* the Codex-environment adaptation layer. The phase logic, argument parsing, flag semantics, the worktree creation/verification, the GitHub-issue in-progress marker (assign `@me` + `in-progress` label), and the merge/close/cleanup steps are all defined in that file — do **not** re-derive or paraphrase them here. If this file and the command file ever disagree, the command file wins.

## Codex invocation

- Invoke as `$claim`, `$claim <slug>`, `$claim #<issue> --issues`, `$claim --review-with=codex`, `$claim --no-review`, and so on. If the user says "claim …" in natural language, treat the remaining text as the same argument string the command file's "Arguments" section parses.
- All flags and arguments are exactly as documented in the command file: `<slug>` / `#<issue>`, `--issues`, `--review-with=<copilot|codex|agy|claude>[,…]`, `--no-review`. Order is free; a value flag accepts either `--flag=value` or `--flag value`.

## Codex command-syntax substitutions

The procedure file is written in Claude Code syntax (`/do:pr`, `/simplify`, …). While following it, translate every sub-command invocation to Codex form:

| In the procedure file | Run in Codex as |
|---|---|
| `/do:pr`      | `$do-pr` |
| `/do:review`  | `$do-review` |
| `/do:replan`  | `$do-replan` |
| `/simplify`   | `$simplify` |

If `$simplify` is not available in this Codex session, skip **only** that layer and state that it was unavailable — still run the `$do-pr` / `$do-review` local-review gate the procedure calls for.

When the procedure's Phase 6 review loop runs the `codex` reviewer CLI, keep its `< /dev/null` stdin redirect (already in the command file's reviewer table) — Codex's `exec` blocks waiting on stdin otherwise.

## Notes

- The procedure file hardcodes the repo root (`/Users/adameivy/github.com/atomantic/PortOS`) and the `data/cos/worktrees/claim-<slug>` worktree convention — use them verbatim.
- The command file is committed to the repo, so it is present in every checkout, including inside `git worktree` checkouts the claim itself creates. If for some reason you genuinely cannot read it, say so rather than improvising a divergent procedure.
