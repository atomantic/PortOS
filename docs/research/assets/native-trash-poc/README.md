# Native trash proof-of-concept assets (issue #12231)

Disposable, self-cleaning smoke tests behind
[`../../2026-10-18-native-trash-feasibility.md`](../../2026-10-18-native-trash-feasibility.md).
Each one recycles synthetic files through the mechanism the study proposes for
that platform, verifies placement and restore metadata, restores one file, and
removes everything it created, including from the Trash / Recycle Bin.

| File | Platform | Status |
|------|----------|--------|
| `mac-poc.mjs` | macOS — `/usr/bin/osascript -l JavaScript` + `NSFileManager.trashItemAtURL` | Executed 2026-10-18 on macOS 26.6 (home volume + RAM-disk volume) |
| `xdgTrash.mjs` | Linux — proposed PortOS-owned freedesktop Trash 1.0 adapter (`node:fs` only) | Executed 2026-10-18 in Docker (Debian bookworm, GLib 2.74, trash-cli 0.17) |
| `linux-poc.mjs`, `linux-docker-run.sh` | Linux harness: home trash, `$topdir/.Trash-$uid`, sticky `$topdir/.Trash/$uid`, refusal, `gio trash` / `trash-cli` interop | Executed with the adapter above |
| `windows-poc.mjs` | Windows — Windows PowerShell 5.1 + shell32 `SHFileOperationW` (`FOF_ALLOWUNDO`) | **Not executed** — no Windows host; its header lists the acceptance checks |

These are investigation tools, not product code: nothing under `server/` imports
them, and the implementation plan in the ADR owns the production versions.
