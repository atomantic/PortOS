import { describe, expect, it, vi } from 'vitest';
import { bufferedSpawn } from '../server/lib/bufferedSpawn.js';
import { reportWindowsCrashDiagnostics } from './ci-windows-crash-diagnostics.js';

const event = {
  AppName: 'node.exe', AppVersion: '24.15.0', ModuleName: 'example-native.dll',
  ModuleVersion: '1.2.3.4', ExceptionCode: 'c0000409', FaultingOffset: '0000000000012345',
};

function setup(result = { success: true, stdout: JSON.stringify([event]) }) {
  return {
    platform: 'win32', run: vi.fn().mockResolvedValue(result),
    logger: { warn: vi.fn() }, writeSummary: vi.fn(),
  };
}

describe('Windows crash diagnostic publication boundary', () => {
  it('retains fault-module evidence while excluding paths, identities and command injection', async () => {
    const options = setup({ success: true, stdout: JSON.stringify([
      { ...event, AppPath: 'C:/Users/example-private/node.exe', Computer: 'example-private-host', Message: 'example-private-message' },
      { ...event, ModuleName: 'C:/Users/example-private/private.dll', ExceptionCode: '\n::error::private' },
    ]) });
    expect(await reportWindowsCrashDiagnostics(Date.now() - 1000, options)).toEqual({ outcome: 'candidates' });
    const published = options.writeSummary.mock.calls[0][0];
    expect(published).toContain('node=24.15.0 module=example-native.dll moduleVersion=1.2.3.4 exception=c0000409 offset=0000000000012345');
    expect(published).toContain('module=unavailable');
    expect(published).toContain('exception=unavailable');
    expect(published).not.toMatch(/private|::error|Users/);
    expect(options.run.mock.calls[0][2]).toMatchObject({ timeoutMs: 10_000 });
  });

  it('distinguishes an empty event window from query/schema failures without echoing stderr', async () => {
    const empty = setup({ success: true, stdout: '[]' });
    expect(await reportWindowsCrashDiagnostics(Date.now(), empty)).toEqual({ outcome: 'no-events' });
    expect(empty.writeSummary.mock.calls[0][0]).toContain('cause remains unverified');
    for (const result of [
      { success: false, timedOut: true, stdout: '[]', stderr: 'example-private-error' },
      { success: true, stdout: '' },
      { success: true, stdout: '{}' },
      { success: true, stdout: JSON.stringify([{ AppName: 42 }]) },
      { success: true, stdout: JSON.stringify(Array(11).fill(event)) },
    ]) {
      const options = setup(result);
      expect(await reportWindowsCrashDiagnostics(Date.now(), options)).toEqual({ outcome: 'unavailable' });
      expect(options.writeSummary.mock.calls[0][0]).toContain('diagnostics unavailable');
      expect(options.writeSummary.mock.calls[0][0]).not.toContain('example-private');
    }
  });

  it('does not turn a missing summary file into a failed test run, or query other platforms', async () => {
    const options = setup();
    options.writeSummary.mockImplementation(() => { throw Error('example-private-path'); });
    expect(await reportWindowsCrashDiagnostics(Date.now(), options)).toEqual({ outcome: 'candidates' });
    expect(options.logger.warn.mock.calls.flat().join('\n')).not.toContain('example-private');
    options.run.mockClear();
    expect(await reportWindowsCrashDiagnostics(Date.now(), { ...options, platform: 'linux' })).toEqual({ outcome: 'not-windows' });
    expect(options.run).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform === 'win32')('real Windows PowerShell diagnostic query', () => {
  it('projects named event XML fields without publishing raw event content', async () => {
    const options = setup();
    options.run = async (command, args, spawnOptions) => {
      const path = args.at(-1).replace(/'/g, "''");
      const result = await bufferedSpawn(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
        function Get-WinEvent {
          param($FilterHashtable, $MaxEvents, $ErrorAction)
          if ($FilterHashtable.Id -ne 1000 -or $MaxEvents -ne 32) { throw 'wrong query' }
          $item = New-Object PSObject
          $item | Add-Member -MemberType ScriptMethod -Name ToXml -Value {
            '<Event><EventData><Data Name="AppName">node.exe</Data><Data Name="AppVersion">24.15.0</Data><Data Name="ModuleName">example-native.dll</Data><Data Name="ModuleVersion">1.2.3.4</Data><Data Name="ExceptionCode">c0000409</Data><Data Name="FaultingOffset">0000000000012345</Data><Data Name="AppPath">example-private-path</Data></EventData></Event>'
          }
          $item
        }
        & '${path}'
      `], spawnOptions);
      expect(result.success, result.stderr).toBe(true);
      expect(result.stdout).not.toContain('example-private');
      return result;
    };
    expect(await reportWindowsCrashDiagnostics(Date.now() - 1000, options)).toEqual({ outcome: 'candidates' });
    expect(options.writeSummary.mock.calls[0][0]).toContain('module=example-native.dll');
  });

  it('can query the real Application Error provider with a bounded empty future window', async () => {
    const options = setup();
    let spawned;
    options.run = async (command, args, spawnOptions) => {
      spawned = await bufferedSpawn(command, args, {
        ...spawnOptions,
        // The 10s production budget runs after the test step, on a quiet runner.
        // Here a cold powershell.exe + Get-WinEvent module load competes with
        // every vitest worker, and a timeout reads as 'unavailable' — that is
        // load, not the query semantics this case pins.
        timeoutMs: 25_000, // inside the 30s test budget, so the facts below still print
        env: { ...spawnOptions.env, PORTOS_CRASH_UNTIL: new Date(Date.now() + 120_000).toISOString() },
      });
      return spawned;
    };
    const result = await reportWindowsCrashDiagnostics(Date.now() + 60_000, options);
    // Bounded facts only: stderr can name the runner's machine or paths.
    expect(result, `timedOut=${spawned?.timedOut} code=${spawned?.code} stdoutBytes=${spawned?.stdout?.length}`)
      .toEqual({ outcome: 'no-events' });
  });
});
