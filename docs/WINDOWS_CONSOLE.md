# Windows: console windows flashing and stealing focus

On Windows you may see a stream of console windows opening and closing across
the desktop — often more than a dozen at once — that grab foreground focus and
render as unusable, half-drawn terminals. In Task Manager they appear as
`OpenConsole.exe` processes started with `-Embedding`.

This document explains the mechanism, how to confirm what is causing it on your
machine, and the two fixes.

## The short version

`OpenConsole.exe -Embedding` is not a program anything launches on purpose. It
is Windows' **default-terminal handoff**, and it fires whenever all three of
these are true:

1. A process **without a console of its own** spawns a child, **and**
2. the child is a **console application** (`git`, `gh`, `psql`, `ffmpeg`,
   `where`, `taskkill`, `cmd`, a Node CLI…), **and**
3. the spawn does **not** pass `CREATE_NO_WINDOW`.

Windows must then allocate a brand-new console. Instead of drawing it with the
classic `conhost.exe`, it hands the console off over COM to whatever is
configured as the **Default terminal application**. On Windows 11 that is
Windows Terminal — including under the default `{00000000-…}` "Let Windows
decide" value. The handoff starts `OpenConsole.exe -Embedding` as the COM local
server and a Windows Terminal window to host it, the window takes foreground
focus, and both die when the short-lived child exits.

One `git status` is a flicker. A background process doing this a few times a
second is a desktop that will not hold focus.

Condition 1 is permanent for PortOS: every PortOS app is a PM2 fork, and PM2
forks have no console. So on Windows, **any** PortOS spawn that omits
`windowsHide: true` produces a focus-stealing window.

## Confirming it on your machine

Console hosts are far too short-lived to catch by polling `Get-Process`. Use a
WMI creation-event trace, which misses nothing:

```powershell
$q = "SELECT * FROM __InstanceCreationEvent WITHIN 0.05 WHERE TargetInstance ISA 'Win32_Process'"
Register-CimIndicationEvent -Query $q -SourceIdentifier Trace | Out-Null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  foreach ($e in (Get-Event -SourceIdentifier Trace -ErrorAction SilentlyContinue)) {
    $t = $e.SourceEventArgs.NewEvent.TargetInstance
    "{0} pid={1} ppid={2} {3} :: {4}" -f $e.TimeGenerated.ToString('HH:mm:ss.fff'),
      $t.ProcessId, $t.ParentProcessId, $t.Name, $t.CommandLine
    Remove-Event -EventIdentifier $e.EventIdentifier
  }
  Start-Sleep -Milliseconds 250
}
Unregister-Event -SourceIdentifier Trace
```

Two things to read out of the trace:

- **Every `OpenConsole.exe -Embedding` line has `ppid` pointing at the DCOM
  launcher (`svchost.exe`), not at the app that caused it.** That is the COM
  activation, and it is why the parent chain never names the real culprit.
- **Attribute by walking the *console child's* ancestry instead** — group the
  `git.exe` / `cmd.exe` / `where.exe` creations by their root ancestor. That is
  what identifies the actual spawner.

PortOS is frequently *not* the only contributor. Any tool that polls git in the
background does the same thing; editor and AI-assistant desktop apps are common
sources, and one of them can easily out-spawn PortOS several times over. Attribute
before you assume.

## Fix 1 (system-wide, fixes every app): stop the terminal handoff

Setting the default terminal to the classic console host removes step 3's
consequence for **everything on the machine**, not just PortOS. Windows still
allocates a console, but draws it with `conhost.exe`, which does not COM-activate
Windows Terminal and does not steal focus.

```bash
npm run fix:windows-console          # set default terminal to Windows Console Host
npm run fix:windows-console -- --show    # print the current setting only
npm run fix:windows-console -- --revert  # restore "Let Windows decide"
```

The equivalent manual route is **Settings → System → For developers → Terminal
→ Windows Console Host**, or in Windows Terminal, **Settings → Startup →
Default terminal application**.

This only writes `HKCU\Console\%%Startup` for the current user, changes no
system state, and takes effect for newly launched console apps. It does not stop
you from using Windows Terminal — it only stops apps from being *forced* into it
when they allocate a console programmatically.

## Fix 2 (PortOS-side): every spawn defaults to hidden

PortOS server code must not import `child_process` directly. It imports
[`server/lib/childProcess.js`](../server/lib/childProcess.js), a drop-in
replacement that defaults `windowsHide: true` (i.e. `CREATE_NO_WINDOW`) on every
`spawn` / `spawnSync` / `fork` / `exec` / `execSync` / `execFile` /
`execFileSync`. `exec` and `execFile` keep their `util.promisify.custom` hooks,
so `promisify(execFile)` still resolves to `{ stdout, stderr }`. An explicit
`windowsHide: false` is honored.

`server/lib/childProcess.guards.test.js` fails the build if a server runtime file
imports `child_process` directly. This bug was fixed twice before by sweeping
`windowsHide: true` across call sites (v1.5.x, v1.6.7) and regressed both times,
because nothing prevented the next new file from omitting it. Owning the import
is the version of the rule that new code cannot silently skip.

Carve-outs, all enforced rather than exempted. Trees that cannot import the
wrapper are held to a **per-call-site** rule instead — every `spawn`/`exec`
family call must carry `windowsHide` itself:

- **`server/lib/aiToolkit/`** is vendored and contractually self-contained (no
  imports out to other PortOS modules), so it applies `windowsHide` inline.
- **`autofixer/` and `browser/`** are separate packages with their own
  `package.json`, so they cannot reach `server/lib/` either — but both are
  PM2-forked apps (`ecosystem.config.cjs`), which puts them in exactly the
  console-less blast radius above.

The per-call-site check is deliberate: a file-level "mentions `windowsHide`
somewhere" test is the weak form of the rule, and would let a second spawn added
to an already-compliant file through unchecked.
- **`shell: true` with a bare `pm2`** is banned separately, but *not* because
  `windowsHide` fails there. Measured on Windows 11: eight `shell: true` spawns
  from a console-less parent produce eight `OpenConsole.exe -Embedding`
  handoffs without `windowsHide`, and zero with it — `shell: true` makes
  `cmd.exe` the direct child, so `CREATE_NO_WINDOW` applies to it and the
  `pm2.cmd`/`node` grandchildren inherit its hidden console. The v1.6.7 sites
  flashed because they passed no `windowsHide` at all. The rule stands on its
  other merits: `execPm2` / `spawnPm2` (`server/services/pm2.js`) exec
  `node pm2/bin/pm2` directly, dropping two process hops and the PATH ambiguity
  of resolving a bare `pm2` through a shell.

  This distinction matters. If you believe `windowsHide` is unreliable, you
  start layering redundant per-call special cases on top of the wrapper — which
  is the failure mode the wrapper exists to end.

### What is *not* affected

**node-pty / ConPTY sessions.** A PTY does allocate its own console host, but
always with `--headless`, which never triggers the terminal handoff and never
draws a window. Web shells and TUI agent sessions were never part of this
symptom, and there is nothing to change there.

That holds because the pinned node-pty is ConPTY-only — its Windows agent has
no winpty fallback path. It is a property of this dependency, not of PTYs in
general, so re-check it on a node-pty major bump. All PTY spawns go through the
one module (`server/services/shell.js`, `server/cos-runner/index.js`,
`server/lib/tuiPromptRunner.js`, `server/lib/tuiUsageScrape.js`), so the blast
radius of that assumption is real.

**`detached: true` spawns.** Windows ignores `CREATE_NO_WINDOW` when
`DETACHED_PROCESS` is set. Those children are safe because they get *no* console
at all — not because `windowsHide` is doing the work. Don't remove `detached`
from a spawn and assume the flag was what protected it.

## Does PortOS need to be launched differently from PowerShell?

**No.** How you start PortOS makes no difference — `npm start`, `pm2 start`, a
shortcut, or a PowerShell profile all end at the same place, because the spawns
that flash come from PM2-forked children, and PM2 forks are console-less no
matter what launched the daemon. Running the launch command from an elevated
prompt, from Windows Terminal, or with `-WindowStyle Hidden` changes nothing.

The two fixes above are the whole story: Fix 1 changes what Windows does with a
newly allocated console, and Fix 2 stops PortOS from allocating one at all.
