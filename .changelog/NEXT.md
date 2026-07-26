# Unreleased Changes

## Client linting

- Client linting now uses ESLint 10 with the maintained ESLint React rule set, preserving PortOS's key React correctness checks without relying on the unmaintained `eslint-plugin-react` compatibility range.

## Sprites

- Sprite turnaround and directional-reference candidates now request a square canvas from image generation and explicitly treat the locked turnaround as the source of truth for accessory side and occlusion. This prevents arbitrary Codex ImageGen candidate aspect ratios and reduces mirrored hip-bag drift before an anchor is locked.

## CoS agent failure reporting

- Failed agent runs are classified far more accurately. A terminal-UI agent's transcript is a repainted *screen*, not a log — it can run to hundreds of kilobytes while containing barely any line breaks — so the analyzer's "look at the recent output" window was quietly reading the entire session. Any keyword anywhere in it, including commands the agent itself typed, decided the verdict: one run reaped for going idle was reported as "Context length exceeded", which blocked its task and auto-filed an investigation for a problem that never happened.
- When the system already knows why a run ended — the idle watchdog fired, the runtime budget ran out, the provider CLI wasn't installed — that is now what gets reported. Only a genuine provider or system error in the transcript can override it.
- Failure snippets shown on an agent's record are now short, readable excerpts centered on the actual error instead of raw terminal escape codes. One failed run had been writing an 816KB blob of control characters into its own record.

## Universe canon corrective reference images

- [issue-3103] Any Cast, Place, or Object entry in a Universe's bible can now take a corrective reference image: upload or pick a photo/render that shows what it should actually look like, and a vision model compares it against the entry's current description and proposes a correction. Reviewing and applying it both fixes the description and pins the image as that entry's reference image, so future renders for it are visually anchored to the correction instead of starting from scratch each time.
- Reference-image pinning (the star toggle on a canon entry's thumbnail) now feeds every future render of that entry, not just its thumbnail — if you'd already pinned a reference image before this update, its next render will be visually anchored to that image too.

## Universe art references

- **[issue-3099] Adding or removing an art reference no longer flickers back when you navigate away and return mid-save** — if you changed a universe's art references and switched to another universe and back before the change finished saving, a slower page refresh could briefly restore the pre-change list on screen, making the next add or remove operate on the wrong set. The saved change now always wins over the older refresh it raced.

## CoS quick task templates

- [issue-3089] The Quick Templates row on the CoS task form now launches real workflows instead of sentence fragments. The eight generic stubs ("Fix the bug where", "Refactor", "Add tests for") only seeded text you had to finish typing anyway; they're replaced by the bundled slashdo workflows an agent can run end to end — Plan a Task, Ship Next Issue, Replan Backlog, Review Changes, Cut a Release, DevSecOps Audit, Prune Dependencies, and Safety Scan.
- Each template also carries the run shape its workflow implies, so picking one sets the worktree/PR/simplify toggles correctly: these workflows either write no code at all or manage their own worktrees and PRs, and wrapping another PortOS worktree around one would nest it. You can still override any toggle afterward, and a template that doesn't specify a toggle leaves your current setting alone.
- The workflow is invoked correctly no matter which agent runs it. Because the provider dropdown defaults to Auto, the template stores the workflow's name rather than a literal `/do:` string — at launch, a Claude Code agent gets `/do:plan-task`, OpenCode gets `/do-plan-task`, and Codex/Grok/Antigravity agents get it named as an Agent Skill. The workflow's full procedure travels with the task in every case, so it also works when the agent is running against one of your other apps rather than PortOS itself, where those slash commands aren't installed.
- Applying a template no longer clears the target application you'd already selected — which had also silently reset that app's worktree and PR defaults.
- `/do:plan-task` and `/do:config` are now available as project slash commands in this repo; they were the only two bundled commands missing a link.
