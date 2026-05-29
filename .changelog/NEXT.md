# Unreleased

## Added

- **Voice coding agent can target a managed app.** When you dispatch a coding task by voice, you can now name a managed app ("fix the failing test in BookLoom") and the agent runs against that app's workspace instead of PortOS itself. The app name is fuzzy-matched, so "book loom", "BookLoom", and "bookloom" all resolve to the same app; if no app matches what you said, the agent refuses with a short list of valid names rather than silently running against PortOS.
