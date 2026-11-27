# ADR: Recycle media through PortOS-owned OS adapters

**Date:** 2026-10-18
**Status:** Accepted and implemented (#12246)


## Context

Media history deletion should be recoverable. The `trash` package brought
transitive dependencies and opaque platform binaries into a host-control app.

## Decision

Own the adapters in [nativeTrash.js](../../server/lib/nativeTrash.js) and
[nativeTrashXdg.js](../../server/lib/nativeTrashXdg.js). Use macOS Trash,
Windows Recycle Bin and freedesktop Trash on Linux. Preserve per-file outcomes
and leave failed items in place. Import the adapter directly.

On macOS, call Foundation's trash API once per process so Finder records
Put Back for each file. On Linux, write freedesktop metadata and require a
safe trash directory on the same mount. Callers retire history only after
verifying the source path is gone.

On Windows, preflight fixed drive type and the shell's BitBucket capacity and
NukeOnDelete settings. The unattended adapter cannot rely on an interactive
warning, which blocked the feasibility probe. Report the PowerShell result
through stdout to avoid CLIXML on a redirected error stream.

## Consequences

The host OS owns restore and retention. Unavailable or unsafe recycling
surfaces as a failure rather than permanent deletion. The platform feasibility
evidence is in [#12231](https://github.com/atomantic/PortOS/issues/12231) and
[PR #12245](https://github.com/atomantic/PortOS/pull/12245).
