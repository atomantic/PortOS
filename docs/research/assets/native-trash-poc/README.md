# Native trash proof-of-concept assets (issue #12231)

Disposable, self-cleaning smoke tests behind
[`../../2026-10-18-native-trash-feasibility.md`](../../2026-10-18-native-trash-feasibility.md).
Each one recycles synthetic files through the mechanism the study proposes for
that platform, verifies placement and restore metadata, restores one file, and
removes everything it created, including from the Trash / Recycle Bin.

| File | Platform | Status |
|------|----------|--------|
| `mac-poc.mjs` | macOS — `/usr/bin/osascript -l JavaScript` + `NSFileManager.trashItemAtURL`; runs the production `MACOS_TRASH_SCRIPT` | Executed 2026-10-18 on macOS 26.6 (home volume + RAM-disk volume); re-run 2026-10-19 on macOS 27 against `server/lib/nativeTrash.js` (#12246) |
| `xdgTrash.mjs` | Linux — re-exports the production adapter `server/lib/nativeTrashXdg.js` (freedesktop Trash 1.0, `node:fs` only) | Executed 2026-10-18 in Docker (Debian bookworm, GLib 2.74, trash-cli 0.17) as the proposed adapter, since shipped unchanged (#12246) |
| `linux-poc.mjs`, `linux-docker-run.sh` | Linux harness: home trash, `$topdir/.Trash-$uid`, sticky `$topdir/.Trash/$uid`, refusal, `gio trash` / `trash-cli` interop | Executed with the adapter above |
| `windows-poc.mjs` | Windows — Windows PowerShell 5.1 + shell32 `SHFileOperationW` (`FOF_ALLOWUNDO`); runs the production `WINDOWS_TRASH_SCRIPT` | Executed 2026-10-19 on a GitHub `windows-latest` runner (Windows PowerShell 5.1, Node 22) against `server/lib/nativeTrash.js`: `PASS` on all six checks, with the no-bin volume supplied as a mapped loopback share and the over-capacity file against a pinned 10 MB `MaxCapacity` (#12246). Exits non-zero unless every acceptance check passes, including the two operator-supplied refusal scenarios |

These are investigation tools, not product code: nothing under `server/` imports
them. They import the production scripts and adapter from `server/lib/` so a
re-run proves what ships, not a copy.
