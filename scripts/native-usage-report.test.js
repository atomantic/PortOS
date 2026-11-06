import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runNativeUsageReportCli } from './native-usage-report.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'native-usage-report.js');

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'native-usage-cli-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const run = async (argv, options = {}) => {
  let out = '';
  let err = '';
  const code = await runNativeUsageReportCli(argv, {
    stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, readSelections: async () => [], ...options,
  });
  return { code, out, err };
};

describe('native usage report CLI', () => {
  it('captures on a host with no native sources, publishing only the contract', async () => {
    await mkdir(join(dir, 'home'));
    const empty = join(dir, 'home');
    const { status, stdout } = spawnSync(process.execPath, [SCRIPT, 'capture'], {
      encoding: 'utf8', timeout: 60_000, env: { HOME: empty, USERPROFILE: empty, PATH: join(dir, 'no-tools'), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.kind).toBe('native-usage-participant-report');
    expect(report.providers.map(({ family, status: state, totals }) => [family, state, totals])).toEqual([
      ['agy', 'unavailable', null], ['claude', 'unavailable', null], ['codex', 'absent', null], ['grok', 'unavailable', null],
    ]);
    expect(stdout).not.toContain(dir);
  });

  it('keeps stdout to the artifact when a service logs, so the output stays parseable', async () => {
    const { out, err } = await run(['capture'], { capture: async () => { console.log('🔌 connected'); return { b: 1, a: 2 }; } });
    expect(out).toBe('{"a":2,"b":1}\n');
    expect(err).toContain('connected');
  });

  it('projects captured files byte-identically on repeat, and refuses invalid input as a refusal', async () => {
    const path = join(dir, 'report.json');
    await writeFile(path, JSON.stringify({ kind: 'not-a-report', sourcePath: join(dir, 'private') }));
    const first = await run(['matrix', path]);
    const second = await run(['matrix', path]);
    expect(first.code).toBe(0);
    expect(second.out).toBe(first.out);
    const matrix = JSON.parse(first.out);
    expect(matrix.refusals).toEqual([{ code: 'report-invalid', family: null, participantKey: null }]);
    expect(first.out).not.toContain(dir);
    expect((await run(['matrix', '--summary', path])).out).toContain('report-invalid');
  });

  it('fails without quoting private paths when a report cannot be read, and rejects bad arguments', async () => {
    const missing = join(dir, 'private-name.json');
    await expect(run(['matrix', missing])).rejects.toThrow(/cannot read a report \(ENOENT\)/);
    await expect(run(['matrix', missing])).rejects.not.toThrow(/private-name/);
    await writeFile(missing, 'not json');
    await expect(run(['matrix', missing])).rejects.toThrow('a report is not valid JSON');
    expect((await run(['matrix'])).code).toBe(2);
    expect((await run(['capture', 'extra'])).code).toBe(2);
    expect((await run(['unknown'])).code).toBe(2);
  });
});
