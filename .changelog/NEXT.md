# Unreleased

## Added

- **Voice coding agent can target a managed app.** When you dispatch a coding task by voice, you can now name a managed app ("fix the failing test in BookLoom") and the agent runs against that app's workspace instead of PortOS itself. The app name is fuzzy-matched, so "book loom", "BookLoom", and "bookloom" all resolve to the same app; if no app matches what you said, the agent refuses with a short list of valid names rather than silently running against PortOS.

## Fixed

- **Creative Director long sessions stay fast.** Per-scene render orchestration no longer slows down as a project accumulates more scenes — previously a project could degrade from ~3.5 minutes per scene to 10–30 minutes after a long run, because every render reread and rewrote the full per-project run history as that history grew unbounded. The Runs tab now shows up to 200 of the most recent run entries per project; older completed/failed runs are dropped automatically while every in-flight task is always preserved.
