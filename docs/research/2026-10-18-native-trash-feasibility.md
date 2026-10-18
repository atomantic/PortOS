# Native trash feasibility: replacing `trash@10.1.1` with PortOS-owned recycling

**Date:** 2026-10-18 · **Issue:** #12231 · **Context:** PR #12212 (recoverable image/video deletion)
**Decision:** [ADR 2026-10-18 — recycle media through OS facilities PortOS owns](../decisions/2026-10-18-native-trash-without-dependency.md)
**Tools and transcripts:** [`assets/native-trash-poc/`](assets/native-trash-poc/README.md)

PR #12212 adds the `trash` package so that deleting a gallery image or a video
history entry moves the originals, sidecars, thumbnails and audio masters to the
server machine's Trash / Recycle Bin instead of unlinking them. Its review asked
whether PortOS could own a smaller implementation with the same native behaviour
and the same safety contract. This study answers that at the existing
`moveToNativeTrash(paths)` boundary in `server/lib/nativeTrash.js`; everything
above it (`trashFiles.js`: literal paths, deduplication, missing-file skips,
directory refusal, test-data isolation, post-operation `lstat` verification,
history/index rows retired only after success, no permanent-delete fallback) is
unchanged by any option below.

**Recommendation: replace the dependency.** Every platform has a recycling
facility reachable from Node without a shipped binary or a new package, and the
PortOS-owned version is *more* faithful than the package on two counts the
package's own source shows (Finder Put Back for every file, original file names
in the Linux trash). macOS and Linux are proven below with real native
execution against disposable files; Windows is designed from the package's own
helper source and from Microsoft's shell API, and is the one piece the
implementing PR must still execute before it ships (acceptance checks are in the
Windows section).

## 1. What `trash@10.1.1` actually ships

Inspected from the published tarball (`npm pack trash@10.1.1`, 772 KB unpacked,
MIT) and the upstream helper repositories it vendors.

| Piece | What it is | Notes for PortOS |
|-------|------------|------------------|
| `index.js` | glob expansion (`globby`), nested-path pruning (`is-path-inside`), `lstat` filter, platform dispatch | PortOS passes `{ glob: false }` and already deduplicates / filters, so this layer is dead weight for us |
| `lib/macos.js` + `lib/macos-trash` | 726 KB universal Mach-O, **ad-hoc signed** (no Team ID), built from [sindresorhus/macos-trash](https://github.com/sindresorhus/macos-trash) 3.x (Swift 6.2 toolchain, macOS 13+) | Calls `FileManager.trashItem(at:resultingItemURL:)`, then rewrites the Trash's `.DS_Store` with `ptbN`/`ptbL` records because, per its own comment, *"FileManager.trashItem has a macOS bug where only the first file gets Put Back metadata"*. On a permission-error **string match** (or `TRASH_FALLBACK=1`) the JS wrapper moves files into `~/.Trash` or **`$PWD/.Trash`** by plain rename — the arbitrary-directory fallback PR #12212 had to bypass by spawning the binary itself |
| `lib/windows.js` + `lib/windows-trash.exe` | 28 KB C program, version 2.0.0, from [sindresorhus/recycle-bin](https://github.com/sindresorhus/recycle-bin) | `IFileOperation::DeleteItems` with `FOFX_ADDUNDORECORD \| FOFX_RECYCLEONDELETE \| FOF_NOERRORUI \| FOF_NOCONFIRMATION \| FOF_SILENT \| FOFX_EARLYFAILURE`, subst-drive resolution, `SHUpdateRecycleBinIcon`. Built with MSVC/gcc on `windows-latest` in the upstream release workflow; not code-signed |
| `lib/linux.js` | freedesktop trash written in JS: trash dir from `xdg-trashdir`, mount table from `@stroncium/procfs`, moves via `move-file`, `p-map` concurrency | Trashed files are renamed to a **random UUID** (the original name survives only inside `.trashinfo`, so a file manager's Trash view shows UUIDs); `Path=` uses `encodeURI` (leaves `#`, `?`, `;` … unescaped although the spec requires RFC 2396 escaping); `Path=` is absolute even in a `$topdir` trash; cross-device moves **copy then delete** |
| `lib/wsl.js` | recycles through Windows PowerShell when running under WSL | needs `wsl-utils` → `powershell-utils` → `execa` |

**Footprint.** The PR's lockfile diff adds **57 entries** for one direct
dependency: the `globby → fast-glob → micromatch/picomatch/@nodelib` chain (for
a glob option PortOS disables), `execa → cross-spawn/get-stream/onetime/…` (for
WSL detection), `@stroncium/procfs`, `xdg-trashdir → @sindresorhus/df /
mount-point / user-home / xdg-basedir` (two generations of `df`), `move-file`,
`is-docker`, `is-wsl`, `pify`, `pinkie`, and two bundled executables that
PortOS's own supply-chain policy would otherwise never admit unsigned.

## 2. Platform comparison

Legend: **pkg** = `trash@10.1.1` as PR #12212 uses it (binary spawned directly on
macOS/Windows, `trash(paths, { glob: false })` on Linux); **own** = the
PortOS-owned design proven/specified below.

### macOS

| Concern | pkg (`macos-trash` binary) | own (`/usr/bin/osascript -l JavaScript`, `NSFileManager.trashItemAtURL`) |
|---------|----------------------------|------------------------------------------------------------------------------|
| Mechanism | same Foundation API, in a shipped Swift binary | same Foundation API, through the JXA ObjC bridge that ships with every macOS — no binary, no compile step |
| Restore metadata (Finder *Put Back*) | binary patches `.DS_Store` itself to work around the one-record-per-process bug | **one `osascript` process per file**; the OS then writes `ptbN`/`ptbL` for every file (reproduced, §3.1). ~45–60 ms per file |
| Collisions | OS renames (`name HH-MM-SS-mmm.ext`) | identical — same API |
| Literal / Unicode paths | argv | argv; spaces, brackets, NFC/NFD, emoji verified |
| Volume boundaries | per-volume `.Trashes/<uid>`; a volume without a trash is an API error | identical (RAM-disk volume verified) |
| Permissions / TCC | the binary inherits the responsible process's TCC posture | identical; verified that the move succeeds and the post-move `lstat` works even when `~/.Trash` cannot be listed |
| Partial success | per-file loop, exit 1 if any failed | identical; per-file JSON on stdout/stderr |
| Process lifecycle | `execFile` + 30 s deadline | identical through `server/lib/childProcess.js` |
| Packaging | 726 KB ad-hoc-signed universal binary inside `node_modules`; Gatekeeper is bypassed only because npm extraction sets no quarantine attribute | nothing to ship |
| Maintenance | track upstream Swift releases | ~20 lines of JXA owned in-tree |
| Fallbacks | JS wrapper falls back to `~/.Trash` / `$PWD/.Trash` (bypassed by PR #12212) | none, by construction |

### Windows

| Concern | pkg (`windows-trash.exe`) | own (Windows PowerShell 5.1 + shell32 `SHFileOperationW`) |
|---------|---------------------------|------------------------------------------------------------|
| Mechanism | `IFileOperation` COM, flags listed in §1 | `SHFileOperationW(FO_DELETE)` with `FOF_ALLOWUNDO \| FOF_NOCONFIRMATION \| FOF_NOERRORUI \| FOF_SILENT \| FOF_WANTNUKEWARNING` through `Add-Type` P/Invoke; `powershell.exe` is a Windows component at a fixed path, resolved the way `interactiveShellResolver.js` already does |
| Restore metadata | `$I<id>` record written by the shell; Explorer *Restore* works | identical — same shell machinery (`FileSystem.DeleteFile(…, SendToRecycleBin)` in `Microsoft.VisualBasic` is the same call) |
| Collisions | shell assigns unique `$I`/`$R` ids | identical |
| Literal / Unicode paths | argv (UTF-16) | newline-separated env var read by the script, so no path meets PowerShell's parser (precedent: `fileCore.js` `DIRSIZE_TARGET`); `-EncodedCommand` carries the script |
| Volumes without a Recycle Bin (network shares, removable media, bin size cap) | **not guarded** — the shell permanently deletes under `FOF_NOCONFIRMATION` when it cannot recycle; the helper sets no guard for it | pre-flight `DriveInfo.DriveType == Fixed` refusal plus `FOF_WANTNUKEWARNING`; the bin-capacity case is an explicit acceptance check (§3.3) |
| Subst drives | resolved by the helper | resolve with `QueryDosDevice` (or refuse) — acceptance check |
| Partial success | `FOFX_EARLYFAILURE` aborts the batch | per-file loop with per-file result |
| Process lifecycle | hidden window via `windowsHide`, 30 s deadline | identical; `Add-Type` compiles once per spawn (expected ~1 s, must be measured) |
| Packaging | 28 KB unsigned `.exe` | nothing to ship |
| Fallbacks | none | none |

### Linux

| Concern | pkg (`lib/linux.js`) | own (`nativeTrashXdg.js`, `node:fs` only — proven as `assets/native-trash-poc/xdgTrash.mjs`) |
|---------|----------------------|--------------------------------------------------------------------------------------------|
| Spec | freedesktop Trash 1.0 | same; output byte-compatible with GLib's `gio trash` (§3.2) |
| Trash directory | `~/.local/share/Trash` for the home device; `$topdir/.Trash/$uid` (sticky check) or `$topdir/.Trash-$uid` via procfs mountinfo + `df` | same selection, with the home trash serving the device the home trash *directory* lives on (`XDG_DATA_HOME` may sit on another volume; its nearest existing ancestor decides); mount point found by walking up until `st_dev` changes — no procfs/df parsing |
| Trash directory validation | `mkdir -p` of whatever is there | the trash dir and its `files/` / `info/` must be non-symlink directories owned by the caller, re-checked after creation; anything else is a `TRASH_DIR_UNSAFE` refusal, so a `.Trash-$uid` symlink planted on a shared volume cannot redirect the move |
| Name in `files/` | random UUID | original name, `stem.N.ext` on collision; `info/` entry opened `O_EXCL` as the reservation; an orphan in `files/` is never overwritten; the stem is shortened by code points when `<name>.trashinfo` would exceed NAME_MAX (255 bytes), the full original path staying in the info file |
| `.trashinfo` | `encodeURI`, absolute `Path=` always | RFC 2396 escaping (verified identical to GLib for space, `#`, `%`, `?`, UTF-8), `Path=` relative to `$topdir` in a volume trash as the spec requires |
| Cross-device | copy + delete | **refuse** (`EXDEV`/`EACCES`) and remove the reservation — same posture as GLib, which also refuses when no per-volume trash can be created |
| Restore | file manager / `trash-cli` | identical — `trash-list` and `trash-restore` verified against our entries |
| Fallbacks | none | none |

## 3. Proof of concept

Every transcript below is from **real native execution on disposable
synthetic files**, not a mocked `process.platform` dispatch. The unit tests in
PR #12212 (`nativeTrash.test.js`) are mocked dispatch tests and stay that way;
the smoke scripts here are the native layer.

### 3.1 macOS — executed

Host: macOS 26.6.2, Node 26, `/usr/bin/osascript -l JavaScript`. Script:
[`assets/native-trash-poc/mac-poc.mjs`](assets/native-trash-poc/mac-poc.mjs).
Run twice, each time on the home volume (`~/.Trash`) and on a freshly created
APFS RAM disk (`/Volumes/PortOSTrashPoc/.Trashes/501`, ejected afterwards).

| Check | Result |
|-------|--------|
| Batch of 4 files (`a sp ace.txt`, `scene[1].png`, `ünïcödé émoji 🎬.txt`, `plain.txt`) in one process | all moved, originals gone, content intact, 48–61 ms per process |
| Put Back records after the 4-file batch | **only the first file** had `ptbN`/`ptbL` (the bug the Swift helper patches around) |
| Same files, **one process per file** | every file had `ptbN` = original name and `ptbL` = original directory (volume-relative on the RAM disk), 44–48 ms each |
| Missing path | exit 1, `NSCocoaErrorDomain` code 4, message names the file; nothing else touched |
| Batch with one missing + one real path | real file recycled, missing one reported, exit 1 — partial success is visible per file |
| Second file with an already-trashed name | OS renamed it `plain.txt 08-01-01-985.txt`; first stayed intact |
| Restore | `rename()` from the trash path back to the original path restored byte-identical content (what Finder's Put Back does) |
| TCC | the shell could not list `~/.Trash` (`EPERM` on `readdir`), yet the move, the per-path `lstat` that `trashFiles.js` relies on, and the cleanup `unlink` all worked — so PortOS's existing verification strategy is the right one |
| Cleanup | every PoC file removed from both trashes; RAM disk ejected |

JXA details that matter for the implementation: out-parameters must be `$()`
(typed nil) — `Ref()` segfaults `osascript` *after* the move has happened,
which would look like a failed recycle of a file that is in fact gone. Return
the JSON from `run()`; on any failure write it to stderr and `$.exit(1)` so the
exit code and the per-file report agree.

### 3.2 Linux — executed

Container: `node:22-bookworm`, uid 1000, GLib 2.74.6 (`gio`), trash-cli
0.17.1.14; four tmpfs volumes for the mount-point cases. The harness exits 1 on any failed assertion; the run recorded here is the second one, after the review hardening (directory validation, home-trash device rule, NAME_MAX bound): `PASS`, 0 failures. Scripts:
[`xdgTrash.mjs`](assets/native-trash-poc/xdgTrash.mjs) (the proposed adapter),
[`linux-poc.mjs`](assets/native-trash-poc/linux-poc.mjs),
[`linux-docker-run.sh`](assets/native-trash-poc/linux-docker-run.sh).

| Check | Result |
|-------|--------|
| Home-device files (`scene[1].png`, `a sp ace.txt`, `ünïcödé 🎬.txt`, `pct%25.txt`, `hash#q?.txt`, `plain.txt`) | all in `~/.local/share/Trash/files/<original name>` with `info/<name>.trashinfo`; trash dirs created `0700` |
| `.trashinfo` vs GLib | ours: `Path=/home/<user>/poc-src/hash%23q%3F.txt`; `gio trash` on `ref ü#.txt`: `Path=/home/<user>/poc-src/ref%20%C3%BC%23.txt` — same escaping, same `DeletionDate` shape |
| Collision | second `plain.txt` → `files/plain.1.txt` + `info/plain.1.txt.trashinfo` |
| User-owned second volume | `/mnt/vol/.Trash-1000/{files,info}` created `0700`, `Path=clips/clip.mp4` (relative to `$topdir`) |
| Root-created sticky `$topdir/.Trash` (1777) | used as `/mnt/vol3/.Trash/1000/…` |
| Root-owned 755 topdir (no trash dir creatable) | `EACCES` refusal, file untouched, no stray `.trashinfo` |
| Root-planted `.Trash-1000 -> /tmp/evil` symlink on a volume | `TRASH_DIR_UNSAFE` refusal, file untouched, link target stays empty |
| 254-byte basename | recycled under a 241-byte stem + `.txt` so the `.trashinfo` name fits NAME_MAX; the info file carries the complete original path |
| `XDG_DATA_HOME` on the second volume | a file on that volume lands in `/mnt/vol/xdg/Trash` — the home trash directory's device decides, not `$HOME`'s |
| Missing path | `ENOENT` before anything is written |
| Interop | `trash-list` showed all eleven entries with decoded original paths across the home, `.Trash-1000`, `.Trash/1000` and `XDG_DATA_HOME` trashes; `trash-restore` restored one back to `~/poc-src/` |

### 3.3 Windows — designed, not executed

No Windows host was available to this run; the macOS/Linux results do not
transfer. The mechanism is specified in runnable form as
[`assets/native-trash-poc/windows-poc.mjs`](assets/native-trash-poc/windows-poc.mjs),
derived from the package's own helper (`recycle-bin.c`) and the documented shell
flags. The harness asserts every check and exits non-zero for anything but
`PASS`; the two refusal scenarios need operator-supplied inputs
(`PORTOS_POC_NO_BIN_DIR`, `PORTOS_POC_OVER_CAPACITY_BYTES`) and the run reports
`INCOMPLETE` without them — an incomplete run is not a pass. Before the Windows
adapter ships, that script must pass on a real interactive Windows session (the
`windows-latest` CI job may or may not expose a Recycle Bin to the runner
account — establish that first):

1. Recycled files are gone from the original path and have a `$I<id>` record
   whose embedded path equals the original (the script parses `$Recycle.Bin`).
2. A file on a volume with no Recycle Bin (mapped share, non-`Fixed`
   `DriveType`) is refused and left in place — **never permanently deleted**.
3. A file larger than the bin's `MaxCapacity` is refused and left in place;
   this is the case where `FOF_NOCONFIRMATION` alone would let the shell
   "nuke" it, and where `FOF_WANTNUKEWARNING` under `FOF_NOERRORUI` must be
   observed to abort rather than prompt or proceed. If it does not, the
   adapter must add a capacity pre-check (per-volume `BitBucket` `MaxCapacity`)
   or switch to the `IFileOperation` interop with `FOFX_RECYCLEONDELETE` and
   re-run this check.
4. A missing path reports a non-zero code without affecting the others.
5. Spaces, brackets, apostrophes and non-ASCII names round-trip.
6. Measured end-to-end time including the `Add-Type` compile stays far inside
   the 30 s deadline; if it exceeds ~3 s, swap the P/Invoke for
   `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(path, 'OnlyErrorDialogs',
   'SendToRecycleBin', 'ThrowException')` (no compile) and re-check 2–3, since
   that wrapper does not set `FOF_NOERRORUI`.

Until that passes, the implementing PR keeps Windows on the current
`windows-trash.exe` path only if it ships before validation — which the ADR
advises against: ship all three adapters together once the Windows checks are
green.

## 4. Safety contract — what each option guarantees

| Guarantee (from `trashFiles.js` / PR #12212) | pkg | own |
|-----------------------------------------------|-----|-----|
| Recoverable host recycling, user-restorable with the OS tools | yes | yes (Put Back now for every file; original names on Linux) |
| No permanent-delete fallback | macOS/Linux yes; **Windows not guaranteed** on non-recyclable volumes | yes on macOS/Linux by API contract and by construction; Windows gated on §3.3 checks 2–3 plus the `DriveType` pre-flight |
| No arbitrary-directory fallback | only because PR #12212 bypasses the wrapper | by construction |
| Literal paths, no glob | `{ glob: false }` | no glob layer exists |
| Partial success visible, history/index rows kept on failure | yes | yes — per-file results; `trashFiles.js` unchanged |
| Bounded process lifecycle | 30 s deadline | 30 s deadline; Linux adapter has no child process at all |

## 5. Regression coverage the implementation must carry

Mocked-dispatch tests (CI on Linux; `pinPlatform` from `testHelper.js`):

- `nativeTrash.test.js`: darwin spawns `/usr/bin/osascript` **once per path**
  with `['-l', 'JavaScript', '-e', <script>, path]`, `{ timeout: 30_000 }`, no
  shell, and the embedded script string is the exported constant (so a test can
  assert it contains `trashItemAtURLResultingItemURLError` and `$.exit(1)`);
  win32 spawns the resolved `powershell.exe` with `-NoProfile -NonInteractive
  -ExecutionPolicy Bypass -EncodedCommand …` and the paths in
  `env.PORTOS_TRASH_PATHS`; linux calls the XDG adapter per path and spawns
  nothing; any other platform rejects. Non-zero exit → rejects with the parsed
  per-file report; `killed` (deadline) → rejects; unparsable stdout → rejects;
  **no fallback path exists to assert against**.
- `nativeTrashXdg.test.js` (real temp filesystem, `XDG_DATA_HOME` pointed at a
  temp dir, `os.homedir` stubbed to a sibling temp dir so `st_dev` matches):
  names with spaces/brackets/`%`/`#`/`?`/UTF-8 produce the expected `Path=`
  escaping and a `DeletionDate` matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$`;
  collision suffixing (`stem.N.ext`) with an `O_EXCL` reservation; an existing
  `files/<name>` without an info file is skipped, not overwritten; a `rename`
  failure (inject `EXDEV`) removes the reservation and leaves the original;
  `ENOENT` for a missing source; the topdir chooser as a pure function over
  `lstat` shapes (sticky dir → `.Trash/<uid>`; symlink / non-sticky / absent →
  `.Trash-<uid>`); a pre-existing symlink or foreign-owned trash directory (or
  `files/` / `info/`) → `TRASH_DIR_UNSAFE` with nothing moved; a 255-byte
  basename recycled under a shortened name with the full path in `Path=`;
  `XDG_DATA_HOME` on a different device than `$HOME` → a file on the data-home
  device uses the home trash.
- `trashFiles.test.js` is already the contract for rejected / false-success /
  unreadable-probe outcomes and needs no change; `deleteImage.test.js`,
  `deleteHistoryItem.test.js` and `mediaAssetMutationAdmission.test.js` keep
  proving that history/index entries survive a failed or partial recycle.

Native smoke (opt-in, never on a developer's real Trash by default):

- The three `assets/native-trash-poc` scripts stay the manual recycle/restore
  proof per platform; the implementing PR re-runs them on macOS and Linux and
  runs the Windows one on a Windows session, recording results in its
  description.
- Optional: a `describe.runIf(process.platform === 'win32' &&
  process.env.PORTOS_NATIVE_TRASH_SMOKE)` test in the Windows CI job that
  recycles a temp file and asserts a matching `$I` record, once check 1 of §3.3
  shows the runner has a usable Recycle Bin.

## 6. Remaining platform validation

- **Windows:** execute `windows-poc.mjs`; checks 2–3 decide whether
  `SHFileOperationW` + pre-flight is sufficient or the `IFileOperation`
  interop is needed. This is the only open question in the study.
- **macOS:** validated on 26.6 only. The JXA bridge and
  `trashItemAtURL` exist since 10.10/10.8 respectively; the `$()`-vs-`Ref()`
  behaviour should be re-checked on the oldest macOS PortOS supports when the
  adapter lands (one `osascript` run of the embedded script).
- **Linux:** validated on Debian bookworm / GLib 2.74 / trash-cli 0.17; the
  adapter has no distro-specific dependency. WSL is a documented difference:
  the package recycles Windows-mounted paths through PowerShell, the adapter
  trashes into an XDG `.Trash-$uid` on the mounted drive — still recoverable,
  just not in the Windows Recycle Bin.

## References

- freedesktop.org Trash specification 1.0 — <https://specifications.freedesktop.org/trash-spec/1.0/>
- Apple `FileManager.trashItem(at:resultingItemURL:)`; JXA ObjC bridge (`ObjC.import`, `$()`)
- Microsoft `SHFileOperationW` / `SHFILEOPSTRUCT` flags (`FOF_ALLOWUNDO`, `FOF_NOERRORUI`, `FOF_WANTNUKEWARNING`), `IFileOperation::SetOperationFlags` (`FOFX_RECYCLEONDELETE`)
- Upstream helper sources: sindresorhus/macos-trash (`Sources/trash/main.swift`), sindresorhus/recycle-bin (`recycle-bin.c`), sindresorhus/trash `lib/linux.js`, `xdg-trashdir`
