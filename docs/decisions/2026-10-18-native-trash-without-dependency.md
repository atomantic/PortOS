# ADR: Recycle media through OS facilities PortOS owns, not the `trash` package

**Date:** 2026-10-18
**Status:** Accepted — macOS and Linux mechanisms proven; the Windows mechanism is specified and must pass its acceptance checks in the implementing PR before any adapter ships. Implemented by issue #12246 (`server/lib/nativeTrash.js`, `server/lib/nativeTrashXdg.js`); the POC harnesses now import the production scripts. Windows checks executed on a `windows-latest` runner: check 2 passed on the `DriveType` pre-flight; check 3 showed that `FOF_WANTNUKEWARNING` makes the shell block on a confirmation no unattended process can answer (the deadline kill left the file intact), so the adapter adds the `BitBucket` `MaxCapacity` / `NukeOnDelete` pre-check — the shell-recorded value when present, else the OS default of 10% of the first 40 GB plus 5% of the rest, which matched the values the shell wrote for two fresh volumes; check 6 measured 0.5 s per batch after first use (4.2 s on a cold runner), so the P/Invoke stays and the `Microsoft.VisualBasic` call is not needed. PowerShell also serialises a redirected error stream as CLIXML, so the report is written to stdout on both paths
**Evidence:** [Native trash feasibility study](../research/2026-10-18-native-trash-feasibility.md) (issue #12231)

## Question

PR #12212 makes gallery image and video-history deletion recoverable by moving
files to the server machine's Trash / Recycle Bin, and reaches that through
`trash@10.1.1`: 57 lockfile entries, a 726 KB ad-hoc-signed Swift binary for
macOS, an unsigned 28 KB C executable for Windows, and a JavaScript freedesktop
implementation for Linux. Should PortOS keep that dependency behind
`moveToNativeTrash(paths)`, or own the recycling code?

## Decision

**Own it.** `server/lib/nativeTrash.js` keeps its `moveToNativeTrash(paths)`
contract and dispatches to three PortOS-owned adapters that use only Node and
components every supported OS already ships:

| OS | Mechanism | Why this one |
|----|-----------|--------------|
| macOS | `/usr/bin/osascript -l JavaScript` running an embedded JXA script that calls `NSFileManager.trashItemAtURL`, **one process per file** | Same Foundation API the package's binary wraps, no binary to ship or sign. One process per file is what gives every file a Finder *Put Back* record — the OS writes the record only for the first `trashItem` call in a process (reproduced on macOS 26.6), which is the bug the package's binary patches `.DS_Store` to hide. ~50 ms per file |
| Windows | Windows PowerShell 5.1 (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, resolved like `interactiveShellResolver.js`) running an `-EncodedCommand` script that P/Invokes shell32 `SHFileOperationW(FO_DELETE)` with `FOF_ALLOWUNDO \| FOF_NOCONFIRMATION \| FOF_NOERRORUI \| FOF_SILENT \| FOF_WANTNUKEWARNING`, paths delivered in `PORTOS_TRASH_PATHS` (newline-separated), with a `DriveType == Fixed` pre-flight | The same shell machinery the package's `IFileOperation` helper and `Microsoft.VisualBasic`'s `SendToRecycleBin` use, without a compiled artifact. The pre-flight closes a hole the package leaves open: under `FOF_NOCONFIRMATION` the shell permanently deletes what it cannot recycle (network shares, removable media, bin capacity) |
| Linux | `server/lib/nativeTrashXdg.js`, a freedesktop Trash 1.0 implementation on `node:fs` (proven as `docs/research/assets/native-trash-poc/xdgTrash.mjs`) | Byte-compatible with GLib's `gio trash` and readable/restorable by `trash-cli`; keeps original file names (the package uses random UUIDs), escapes `Path=` per the spec, writes `$topdir`-relative paths in volume trashes, honours the sticky `$topdir/.Trash` rule, refuses a trash directory that is not a caller-owned real directory (`TRASH_DIR_UNSAFE`, so a symlink planted on a shared volume cannot redirect the move), keeps `.trashinfo` names within NAME_MAX, discovers the volume from the physical parent so a directory symlink cannot misplace the trash, and refuses instead of copying across devices |

Nothing above `moveToNativeTrash` changes: `trashFiles.js` still filters to
existing literal files, refuses directories, guards test data, verifies each
path is gone afterwards, and callers retire history/index rows only after that
verification. There is still no permanent-delete fallback and no
arbitrary-directory fallback — on macOS and Linux by API contract and by
construction, on Windows by the pre-flight plus the acceptance checks below.

## Why

- **Parity is not a trade-off here; the owned code is more faithful.** Every
  file gets Finder Put Back (the package's wrapper-level fallback and
  `.DS_Store` patching exist to paper over exactly the behaviours we avoid by
  spawning per file); Linux trash entries carry their real names and
  spec-correct metadata; Windows gains a guard against silent permanent
  deletion that the package does not have.
- **The dependency buys code PortOS disables.** Of the 57 packages, the glob
  stack serves `{ glob: true }` (we pass `false`), the `execa`/`wsl-utils`
  stack serves WSL, and `procfs`/`df`/`mount-point` reimplement a `st_dev` walk
  that is ten lines of `node:fs`. The remaining value — three OS calls — is what
  the adapters contain.
- **No binaries in the supply chain.** PortOS updates through `git pull` and
  `npm ci` on many independent installs (see the distribution model in
  `AGENTS.md`). An ad-hoc-signed Mach-O and an unsigned `.exe` inside
  `node_modules` run today only because npm extraction sets no quarantine
  attribute; owning a native helper ourselves would mean a Swift/MSVC build,
  signing/notarization and a committed binary — none of which is needed when
  `osascript` and `powershell.exe` are already on the machine.
- **Risk is bounded by the existing contract.** The adapters fail closed; the
  worst case of a wrong adapter is a refused deletion with the file still in
  place, which `trashFiles.js` already reports as `MEDIA_TRASH_FAILED` (503)
  without touching history.

## Implementation plan

One PR, all three adapters together, after the Windows checks pass. If PR
#12212 is still open when the work starts, land this inside it (drop the
dependency before it ever reaches `main`); otherwise a follow-up PR that
replaces the adapter and records the removal in `docs/DEPS.md`.

1. **`server/lib/nativeTrash.js`** — keep `moveToNativeTrash(paths)`;
   dispatch on `process.platform`: `darwin` → `for` each path `execFile(
   '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_TRASH_SCRIPT, path],
   { timeout: 30_000 })` via `server/lib/childProcess.js`; `win32` → one
   `execFile(resolveWindowsPowerShell(), ['-NoProfile', '-NonInteractive',
   '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout:
   30_000, env: { ...process.env, PORTOS_TRASH_PATHS: paths.join('\n') } })`;
   `linux` → `for` each path `await trashXdg(path)`; anything else throws.
   Export the two script constants for tests. Parse the per-file JSON on
   stdout/stderr and reject with a bounded `Error` carrying `code` and the
   per-file report; never consult the report to decide a fallback.
   Embedded scripts: the JXA and PowerShell bodies in
   `docs/research/assets/native-trash-poc/{mac,windows}-poc.mjs` (`$()` typed
   nil out-params on macOS; `[char]10` split, `Test-Path -LiteralPath`,
   `DriveType` pre-flight, `exit 1` on any failure on Windows).
2. **`server/lib/nativeTrashXdg.js`** — move `xdgTrash.mjs` in as
   `trashXdg(path)`, unchanged in behaviour; add the barrel export in
   `server/lib/index.js` and a row in `server/lib/README.md`.
3. **Tests** — the regression matrix in §5 of the study: `nativeTrash.test.js`
   (mocked dispatch per platform, per-file spawn count, argv shape, env
   delivery, deadline/killed, non-zero exit, unparsable output, no fallback)
   and `nativeTrashXdg.test.js` (real temp filesystem: escaping, date shape,
   collision + `O_EXCL` reservation, orphan protection, `EXDEV` cleanup,
   `ENOENT`, topdir chooser, `TRASH_DIR_UNSAFE` on a symlinked or
   foreign-owned trash directory, NAME_MAX-length names and extensions,
   directory symlink into another volume, `XDG_DATA_HOME` on another device). `trashFiles.test.js` and the three caller suites
   stay as the contract for partial success and history preservation.
4. **Windows validation gate** — run
   `docs/research/assets/native-trash-poc/windows-poc.mjs` on an interactive
   Windows session with `PORTOS_POC_NO_BIN_DIR` and
   `PORTOS_POC_OVER_CAPACITY_BYTES` set, and paste the (redacted) report in the
   PR; the harness exits non-zero for anything but `PASS`. Checks 2 and 3
   (no-bin volume and over-capacity file are refused, never deleted) decide
   between `SHFileOperationW` + pre-flight, adding a `BitBucket` `MaxCapacity`
   pre-check, or an `IFileOperation` interop with `FOFX_RECYCLEONDELETE`.
   Check 6 decides between the P/Invoke and the no-compile
   `Microsoft.VisualBasic` call. Optionally wire the opt-in
   `PORTOS_NATIVE_TRASH_SMOKE` test into the `windows-latest` CI job once the
   runner is shown to have a usable Recycle Bin.
5. **Manifests and docs** — remove `trash` from `server/package.json` and
   regenerate `server/package-lock.json` (expect the 57 entries listed in the
   study to disappear; run `npm ls` to confirm nothing else pulled them);
   `docs/DEPS.md`: delete the row if the dependency never merged, otherwise a
   `REPLACED` row pointing here (the `deps-doc.test.js` parity guard accepts
   either); update the recycling paragraph of `docs/IMAGE_GALLERY.md`
   (per-file Finder Put Back, original names in Linux trash, Windows refusal on
   volumes without a Recycle Bin); add the Linux adapter to the storage/ops
   docs only if an operator-visible path is introduced (none is planned —
   trash locations are the OS defaults).
6. **CI/packaging** — nothing new: no native build, no signing, no
   postinstall. The Windows shard already runs the server suite; the Linux
   adapter's real-filesystem tests run everywhere.

## Alternatives considered

- **Keep `trash` and accept the footprint.** Rejected: it ships two unsigned
  binaries, 50+ transitive packages mostly serving disabled features, a
  wrapper fallback the PR already has to bypass, and weaker restore metadata on
  two of three platforms.
- **Ship a PortOS-built native helper** (Swift / C). Rejected: adds a
  toolchain, signing/notarization and a committed binary for behaviour that
  the OS exposes through `osascript` and `powershell.exe` already.
- **AppleScript to Finder (`tell application "Finder" to delete`).** Rejected:
  Apple Events need an Automation TCC grant for the responsible process, which
  an unattended PM2 server cannot answer; `NSFileManager` needs none.
- **`gio trash` on Linux.** Not needed as a dependency: the adapter produces
  identical output; `gio` remains a fine verification tool and is absent on
  many servers.
- **`Shell.Application` COM on Windows.** Rejected: shows confirmation UI
  depending on user settings.

## Consequences

- One fewer direct dependency and 57 fewer lockfile entries; no bundled
  executables.
- macOS deletes spawn one short-lived `osascript` per file (deletion batches
  are a handful of files; ~50 ms each).
- Windows deletes pay an `Add-Type` compile per batch (about 0.5 s once the
  runtime is warm); check 6 confirmed that is well inside the deadline.
- WSL installs recycle into an XDG trash on the mounted drive rather than the
  Windows Recycle Bin; documented, recoverable, out of scope.
- If a future macOS release changes the per-process Put Back behaviour, the
  per-file spawn keeps working (it is correct either way); only the
  investigation's rationale becomes historical.
