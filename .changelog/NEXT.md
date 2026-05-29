# Unreleased

## Changed

- **[patch-settings-slice-helper] Nested settings edits no longer risk clobbering sibling fields.** Saving a Python path from Video Gen, or an image-gen config from a pipeline / Writers Room stage, used to round-trip the entire current settings object — leaving unrelated top-level keys exposed to drift if the read raced a concurrent write elsewhere. These edits now scope themselves to the slice being changed.

## Added

- **Voice coding agent can target a managed app.** When you dispatch a coding task by voice, you can now name a managed app ("fix the failing test in BookLoom") and the agent runs against that app's workspace instead of PortOS itself. The app name is fuzzy-matched, so "book loom", "BookLoom", and "bookloom" all resolve to the same app; if no app matches what you said, the agent refuses with a short list of valid names rather than silently running against PortOS.
- **[voice-code-agent-status-query] Ask voice how a dispatched coding task is going.** A new voice query — "how's that coding task going?", "status of the agent", "is the agent still working?" — reports each in-flight voice-dispatched coding task with its current phase, target app, elapsed time, and a snippet of the task description. Until now you could only learn the outcome from the completion announcement; this is the mid-task check-in. Also available as "Coding agent status" in the command palette.

## Fixed

- **Creative Director long sessions stay fast.** Per-scene render orchestration no longer slows down as a project accumulates more scenes — previously a project could degrade from ~3.5 minutes per scene to 10–30 minutes after a long run, because every render reread and rewrote the full per-project run history as that history grew unbounded. The Runs tab now shows up to 200 of the most recent run entries per project; older completed/failed runs are dropped automatically while every in-flight task is always preserved.
- **[triage-gemini-out-of-scope-findings] Editor and Claude Code can now open managed apps on Windows.** "Open in Editor" and "Open in Claude" buttons now resolve `.cmd`/`.bat` shims (e.g. `code.cmd`, `claude.cmd`) that Node otherwise refuses to spawn — previously these actions silently failed on Windows installs.
- **[triage-gemini-out-of-scope-findings] Custom app start commands keep quoted arguments intact.** Apps whose start command includes a quoted path or option (`node --opt "arg with spaces"`) now launch with that argument preserved; previously the runner shredded the quotes and PM2 received the broken pieces.
- **[triage-gemini-out-of-scope-findings] Unknown task-type names return a clear error instead of silent no-ops.** Toggling a task-type override (per-app or bulk) now rejects unrecognized names with a 400, so a typo can no longer create a phantom override that quietly never runs.
- **[ref-watch-phosphene-strip-malloc-subprocess-env] Image and video generation no longer flood logs with `MallocStackLogging` warnings.** When PortOS is launched from Pinokio or any tool that exports macOS `Malloc*` debugging env vars, every Python helper used to print "can't turn off malloc stack logging because it was not enabled" once per child exit — dozens of lines per render, burying real progress. Those vars are now stripped before each spawn.
