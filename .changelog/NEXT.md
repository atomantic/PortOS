# Unreleased Changes

## Client linting

- Client linting now uses ESLint 10 with the maintained ESLint React rule set, preserving PortOS's key React correctness checks without relying on the unmaintained `eslint-plugin-react` compatibility range.

## CoS agent failure reporting

- Failed agent runs are classified far more accurately. A terminal-UI agent's transcript is a repainted *screen*, not a log — it can run to hundreds of kilobytes while containing barely any line breaks — so the analyzer's "look at the recent output" window was quietly reading the entire session. Any keyword anywhere in it, including commands the agent itself typed, decided the verdict: one run reaped for going idle was reported as "Context length exceeded", which blocked its task and auto-filed an investigation for a problem that never happened.
- When the system already knows why a run ended — the idle watchdog fired, the runtime budget ran out, the provider CLI wasn't installed — that is now what gets reported. Only a genuine provider or system error in the transcript can override it.
- Failure snippets shown on an agent's record are now short, readable excerpts centered on the actual error instead of raw terminal escape codes. One failed run had been writing an 816KB blob of control characters into its own record.

## Universe canon corrective reference images

- [issue-3103] Any Cast, Place, or Object entry in a Universe's bible can now take a corrective reference image: upload or pick a photo/render that shows what it should actually look like, and a vision model compares it against the entry's current description and proposes a correction. Reviewing and applying it both fixes the description and pins the image as that entry's reference image, so future renders for it are visually anchored to the correction instead of starting from scratch each time.
- Reference-image pinning (the star toggle on a canon entry's thumbnail) now feeds every future render of that entry, not just its thumbnail — if you'd already pinned a reference image before this update, its next render will be visually anchored to that image too.
