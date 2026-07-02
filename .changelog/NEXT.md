# Unreleased Changes

## Delete confirmations

- **Destructive actions now show a clear "Delete? / Cancel" prompt instead of a hidden second click.** Deleting a round, universe, series, share bucket, issue/episode, or a Writers Room work/folder — and removing an Ask conversation or deleting a world in the Universe Builder — used to silently re-arm the same button on the first click, with nothing on screen telling you a second click was needed. Each of these now pops an explicit inline confirm/cancel affordance right where you clicked, so it's obvious what will happen and easy to back out. The pipeline's "replace existing scenes / pages / audio lines" extract buttons got the same treatment (an inline "Replace? / Cancel" row) instead of arming via a fleeting toast. Delete/confirm controls in the Writers Room library were also enlarged to a comfortable 44px touch target for mobile.

## Deep-linkable selections

- **Picking an author, music artist/album/track, share bucket, prompt stage/variable, or JIRA report now lives in the URL — so it's shareable, bookmarkable, reload-safe, and reachable from ⌘K / voice / the back button (#2025).** These master-detail pages previously kept the open record in local state, so a pasted link or a reload always dropped you back on an empty list. Authors now open at `/authors/:id` (`/authors/new` to create), the Music tabs at `/music/:tab/:id`, Sharing buckets at `/sharing/buckets/:bucketId`, the Prompt Manager via `?stage=` / `?var=`, and JIRA Reports via `?reportApp=&reportDate=`. Deleting or clearing a selection returns to the index, and a stale/deleted id now shows a "could not be found" fallback instead of a blank pane. (OpenClaw's session picker stays local by design — its sessions are ephemeral runtime state, not user-owned records.)

## Accessibility

- **Config form labels now focus their field when clicked and read correctly to screen readers.** Many settings/config forms (AI Providers, DataDog, feature-agent config, message & calendar account setup, scheduled-task provider/model pickers, the agent world/schedule tabs, MeatSpace nicotine + POST drills, and more) rendered the label as a plain sibling of its input with no association, so clicking the label did nothing and assistive tech couldn't announce the pairing. These fields now flow through a shared `FormField` wrapper that generates a stable id and wires `htmlFor`/`id` automatically, keeping the exact same styling (#2027). Remaining forms are tracked for a follow-up sweep (#2051).

## Internal

- Migration 155 heals `data/prompts/stages/cd-treatment.md` installs that #1808's anchor-based migration 148 left stranded (#2042). Installs seeded before the `imageStrength` scene knob (older pre-#1808 template) got the `## Cast & ingredients` list but missed the per-scene `"cast": [{ "ingredientId": … }]` field, so the Creative Director cast-threading regression test stayed red on the runtime template and migration 148 (already applied) never re-ran. The new hash-driven prompt-replace upgrades those copies (and both pristine pre-#1808 shipped versions) to the current shipped reference, leaving hand-customized copies untouched. Also folds `cd-treatment.md` into `buildPromptDriftTables` so setup-data.js's drift warning classifies a stranded copy correctly.
