/**
 * OS recycling adapters PortOS owns — no third-party package, no bundled
 * binary (ADR docs/decisions/2026-10-18-native-trash-without-dependency.md).
 *
 * `moveToNativeTrash(paths)` dispatches on `process.platform`:
 * - darwin: `/usr/bin/osascript -l JavaScript` running `MACOS_TRASH_SCRIPT`
 *   (`NSFileManager.trashItemAtURL`), ONE process per file — the OS writes a
 *   Finder "Put Back" record only for the first trashItem call in a process.
 * - win32: Windows PowerShell 5.1 running `WINDOWS_TRASH_SCRIPT` (shell32
 *   `SHFileOperationW` with `FOF_ALLOWUNDO`), one process per batch, the paths
 *   delivered in `PORTOS_TRASH_PATHS` so none touches PowerShell's parser.
 * - linux: `trashXdg()` per file (freedesktop Trash 1.0 on `node:fs`).
 *
 * Every adapter fails closed: a refusal rejects with a bounded coded Error and
 * the original file still in place. There is deliberately no permanent-delete
 * fallback and no fallback directory; `trashFiles.js` verifies afterwards that
 * each path is gone before callers retire history rows.
 *
 * Both scripts share one contract: a JSON array of per-file results on stdout,
 * and the exit code decides success. Nothing is read from stderr — PowerShell
 * serialises a redirected error stream as CLIXML, and osascript mixes its own
 * diagnostics into it.
 */
import { promisify } from 'node:util';
import { execFile } from './childProcess.js';
import { codedError } from './codedError.js';
import { windowsPowerShell51Path } from './processEnv.js';
import { trashXdg } from './nativeTrashXdg.js';

const execFileAsync = promisify(execFile);
export const NATIVE_TRASH_DEADLINE_MS = 30_000;

// JXA with the ObjC bridge. `$()` (typed nil) is the out-parameter idiom that
// works on current macOS; `Ref()` crashes osascript after the move succeeds.
export const MACOS_TRASH_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('stdlib');
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  const results = [];
  let failed = false;
  for (const path of argv) {
    const trashedUrl = $();
    const error = $();
    const ok = fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), trashedUrl, error);
    if (ok) results.push({ path, trashedPath: ObjC.unwrap(trashedUrl.path) });
    else {
      failed = true;
      results.push({ path, code: Number(error.code), domain: ObjC.unwrap(error.domain), error: ObjC.unwrap(error.localizedDescription) });
    }
  }
  const out = JSON.stringify(results);
  if (failed) {
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(out).dataUsingEncoding($.NSUTF8StringEncoding));
    $.exit(1);
  }
  return out;
}`;

// Windows PowerShell 5.1 + .NET Framework P/Invoke. The DriveType pre-flight
// is load-bearing: under FOF_NOCONFIRMATION the shell permanently deletes what
// it cannot recycle (network shares, removable media), so only a Fixed drive —
// the only kind that owns a $Recycle.Bin — is ever handed to the shell, and
// UNC paths never reach DriveInfo (it throws on them). It must run before the
// capacity check so a UNC root never reaches GetVolumeNameForVolumeMountPoint.
// The capacity / disabled-bin pre-flight is advisory: FOF_WANTNUKEWARNING makes
// the shell block on a confirmation no unattended process can answer
// (reproduced on the windows-latest runner), so the deadline kill is the data
// guard and a stale capacity value costs time, not files.
export const WINDOWS_TRASH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class PortOSRecycle {
  // 64-bit layout (no Pack): PortOS runs under 64-bit Node; Pack=1 is the x86 layout.
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperationW(ref SHFILEOPSTRUCT op);
  const uint FO_DELETE = 3;
  // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI | FOF_WANTNUKEWARNING
  const ushort FLAGS = 0x0004 | 0x0010 | 0x0040 | 0x0400 | 0x4000;
  public static int Recycle(string path, out bool aborted) {
    var op = new SHFILEOPSTRUCT { wFunc = FO_DELETE, pFrom = path + "\0\0", fFlags = FLAGS };
    int rc = SHFileOperationW(ref op);
    aborted = op.fAnyOperationsAborted;
    return rc;
  }
  public static string DriveType(string path) {
    string root = Path.GetPathRoot(path);
    if (root == null || root.StartsWith(@"\\")) return "Network";
    return new DriveInfo(root).DriveType.ToString();
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool GetVolumeNameForVolumeMountPoint(string mountPoint, System.Text.StringBuilder volumeName, uint bufferLength);
  // Recycle Bin capacity the shell honours for the volume at root, in bytes:
  // the per-volume HKCU BitBucket MaxCapacity (MB) once the shell has recorded
  // one, else the OS default (10% of the first 40 GB plus 5% of the rest).
  // 0 means recycling is disabled for the volume (NukeOnDelete or policy).
  public static long BinCapacityBytes(string root) {
    foreach (var hive in new[] { Microsoft.Win32.Registry.CurrentUser, Microsoft.Win32.Registry.LocalMachine }) {
      using (var policy = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer")) {
        if (policy != null && Convert.ToInt32(policy.GetValue("NoRecycleFiles", 0)) != 0) return 0;
      }
    }
    long capacityMb = -1;
    var volume = new System.Text.StringBuilder(64);
    if (GetVolumeNameForVolumeMountPoint(root, volume, 64)) {
      var guid = System.Text.RegularExpressions.Regex.Match(volume.ToString(), @"\{[0-9A-Fa-f-]+\}");
      if (guid.Success) {
        using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\" + guid.Value)) {
          if (key != null) {
            if (Convert.ToInt32(key.GetValue("NukeOnDelete", 0)) != 0) return 0;
            object max = key.GetValue("MaxCapacity");
            if (max != null) capacityMb = Convert.ToInt64(max);
          }
        }
      }
    }
    if (capacityMb < 0) {
      long totalMb = new DriveInfo(root).TotalSize / (1024L * 1024L);
      capacityMb = totalMb <= 40960 ? totalMb / 10 : 4096 + (totalMb - 40960) / 20;
    }
    return capacityMb * 1024L * 1024L;
  }
}
'@
$results = @()
$failed = $false
foreach ($path in ($env:PORTOS_TRASH_PATHS -split [char]10 | Where-Object { $_ -ne '' })) {
  if (-not (Test-Path -LiteralPath $path)) { $failed = $true; $results += @{ path = $path; code = 2; error = 'missing' }; continue }
  $type = [PortOSRecycle]::DriveType($path)
  if ($type -ne 'Fixed') { $failed = $true; $results += @{ path = $path; code = -1; error = "no recycle bin on $type drive" }; continue }
  $capacity = [PortOSRecycle]::BinCapacityBytes([IO.Path]::GetPathRoot($path))
  if ($capacity -le 0) { $failed = $true; $results += @{ path = $path; code = -2; error = 'recycle bin disabled on this volume' }; continue }
  $size = (Get-Item -LiteralPath $path -Force).Length
  if ($size -gt $capacity) { $failed = $true; $results += @{ path = $path; code = -3; error = 'file larger than the recycle bin capacity'; size = $size; capacity = $capacity }; continue }
  $aborted = $false
  $rc = [PortOSRecycle]::Recycle($path, [ref]$aborted)
  if ($rc -ne 0 -or $aborted -or (Test-Path -LiteralPath $path)) { $failed = $true; $results += @{ path = $path; code = $rc; aborted = $aborted } }
  else { $results += @{ path = $path; recycled = $true } }
}
[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @($results)))
if ($failed) { exit 1 }
`;

const WINDOWS_ENCODED_SCRIPT = Buffer.from(WINDOWS_TRASH_SCRIPT, 'utf16le').toString('base64');

// Both scripts print one JSON array; anything else is treated as no report.
function parseReport(text) {
  try {
    const parsed = JSON.parse(String(text ?? '').replace(/^\uFEFF/, '').trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

// Run a reporting script to completion. The per-file report rides on the
// rejection for diagnostics only; nothing here or upstream reads it to choose
// another deletion strategy.
async function runReportingScript(file, args, options, label) {
  let stdout;
  let closed;
  try {
    const execution = execFileAsync(file, args, { ...options, timeout: NATIVE_TRASH_DEADLINE_MS });
    // AbortError may arrive before child close. Keep the operation pending until
    // its owned process is terminal so callers can safely clean up source files.
    if (execution.child) closed = new Promise(resolve => execution.child.once('close', resolve));
    ({ stdout } = await execution);
  } catch (error) {
    if (options.signal?.aborted) {
      await closed;
      throw codedError(`${label} recycle aborted`, 'TRASH_ABORTED');
    }
    if (error.killed) throw codedError(`${label} recycle exceeded the ${NATIVE_TRASH_DEADLINE_MS}ms deadline`, 'TRASH_DEADLINE');
    throw Object.assign(codedError(`${label} recycle refused`, 'TRASH_REFUSED'), { exitCode: error.code, report: parseReport(error.stdout) });
  }
  const report = parseReport(stdout);
  if (!report) throw codedError(`${label} recycle produced no report`, 'TRASH_UNPARSABLE');
  return report;
}

export async function moveToNativeTrash(paths, { signal } = {}) {
  const cancellation = signal ? { signal } : {};
  signal?.throwIfAborted();
  switch (process.platform) {
    case 'darwin':
      for (const path of paths) {
        await runReportingScript('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_TRASH_SCRIPT, path], cancellation, 'macOS');
      }
      return;
    case 'win32':
      // PowerShell 7 is not a substitute: the script targets the .NET Framework Add-Type compiler.
      await runReportingScript(
        windowsPowerShell51Path(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', WINDOWS_ENCODED_SCRIPT],
        { ...cancellation, env: { ...process.env, PORTOS_TRASH_PATHS: paths.join('\n') } },
        'Windows',
      );
      return;
    case 'linux':
      for (const path of paths) await trashXdg(path);
      return;
    default:
      throw codedError('Native trash is unavailable on this platform', 'TRASH_UNSUPPORTED_PLATFORM');
  }
}
