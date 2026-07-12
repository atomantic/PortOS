# Optional (non-blocking) code reviewers

**Date:** 2026-07-12
**Status:** DONE — slashdo side merged (PR #110); PortOS side implemented (this PR, closes #2481).
**Motivation:** A local Ollama reviewer is a useful second opinion but frequently returns no verdict (timeout / empty / partial coverage). Today that flips the multi-reviewer aggregate to `inconclusive`, which blocks a saved `--merge` and strands the PR behind a reviewer that was never meant to gate. See memory `project_ollama_reviewer_no_verdict_blocks_merge`.

## Design decisions (locked with the user)

1. **Marker syntax:** a shell-safe inline suffix `~opt` on a `--review-with` slot — `claude,ollama~opt,codex`, `ollama[qwen2.5-coder:32b]~opt`, `@flaky-bot~opt`. Chosen over the originally-proposed `(o)` because `()` are shell metacharacters (subshell) and would violate the "inert wherever it lands in a command string" property the reviewer-token grammar maintains. Chosen over a separate `--review-optional` flag to keep the marker co-located and riding through saved defaults verbatim.
2. **Semantics — inconclusive-only:** an optional reviewer still runs and still has its findings fixed; only its *inconclusive* result (timeout / skipped / incomplete / no-verdict) is excluded from the merge gate. A **hard-error** from it (broken build / failed tests / rejected) still blocks — optionality never merges a broken tree.

## Part 1 — slashdo (`atomantic/slashdo`) — DONE (PR #110)

`~opt` is stripped into a per-entry `{OPTIONAL}` flag before slug/`[model]`/`@login` parsing; not part of the dedup identity (`ollama~opt` == `ollama`, optional-wins on collapse). `lib/multi-reviewer-loop.md` excludes optional passes from the `{OVERALL_STATUS}=inconclusive` determination (series + parallel) and adds an Optional column; every `--review-with` command + `/do:config` save-path recognizes it; `next` inherits via pass-through. Once merged, **bump the PortOS submodule** (`git submodule update --remote lib/slashdo`, commit the pointer).

## Part 2 — PortOS (this repo) — PENDING (gated on Part 1 merge + submodule bump)

PortOS already owns the reviewer config that feeds agentic (`/do:next`, `/do:pr`) runs — extend it, don't rebuild it.

### Data / schema (`server/lib/cosValidation.js`)
- Add `optionalReviewers: string[]` to **`codeReviewSettingsSchema`** (the Code Review Defaults slice) and to the **task-metadata** reviewer shape (the `reviewers` sub-object near line 237). Additive + optional (defaults to `[]`) — settings merge is additive, so **no data migration** needed; the loader already tolerates absent keys.
- Entries are reviewer identities: the keyed slugs (`ollama`, `lmstudio`, `claude`, `codex`, `copilot`, …) and `@username` tokens. Validate each is a member of the effective reviewer list (drop unknowns), mirroring `normalizeReviewUsernames`.

### Builder (`server/lib/cosValidation.js`)
- `buildReviewWithArgs(reviewers, stopMode, reviewerApplies, usernames, optionalReviewers = [])`: when emitting each token, append `~opt` if that reviewer identity is in `optionalReviewers`. Keep the existing ordering/default-only/stop-mode logic intact.
- `buildReviewersCsv(...)`: same `~opt` appending for the prompt `{reviewers}` placeholder.
- Note: PortOS's `ollama`/`lmstudio` are flat enum keys that route through PortOS's own local code-review endpoint; the optional flag here is a per-key boolean, independent of slashdo's `[model]` bracket (PortOS configures the model separately). So `optionalReviewers` stores plain keys/`@user`, and `buildReviewWithArgs` appends `~opt` to the matching emitted token.

### Prompt builder (`server/services/agentPromptBuilder.js`)
- The three `buildReviewWithArgs(...)` call sites (~lines 330, 1159, 1300) must thread `optionalReviewers` through. Mirror how the reviewer-`--model` map is threaded (memory `project_reviewer_model_threading_map`): thread the value verbatim, do not remap.

### UI
- `client/src/components/cos/ReviewerPicker.jsx`: add a per-reviewer "non-blocking" toggle (a small badge/checkbox on each selected reviewer chip). Selecting it adds the reviewer key to `optionalReviewers`.
- `client/src/components/providers/CodeReviewDefaultsPanel.jsx`: surface the same toggle for the saved defaults.
- `client/src/hooks/useCodeReviewDefaults.jsx` + `client/src/services/apiCodeReview.js`: carry `optionalReviewers` through load/save.
- `client/src/components/cos/constants.js`: no change (REVIEWER_OPTIONS unchanged); the picker gains the toggle.

### Tests
- `cosValidation` builder tests: `buildReviewWithArgs` / `buildReviewersCsv` emit `~opt` for the marked reviewers, in the right position, and only for members.
- `ReviewerPicker` test: toggling non-blocking updates `optionalReviewers`.

### Changelog
- `.changelog/NEXT.md` entry once implemented.

## Sequencing
1. Merge slashdo PR #110.
2. Bump PortOS `lib/slashdo` submodule to the merged commit; commit the pointer.
3. Implement Part 2 as its own PortOS PR.
