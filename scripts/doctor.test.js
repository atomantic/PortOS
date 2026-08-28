/**
 * `npm run doctor` contract (#5304).
 *
 * The probes themselves are thin delegations to helpers that have their own
 * tests (`checkNodeVersion`, `commandExists`, `listPendingMigrations`), so what
 * is worth pinning here is the part unique to the doctor: its totality. A
 * diagnostic that crashes, hangs, or leaks the user's username into the block
 * they are about to paste into a bug report is worse than no diagnostic, and
 * each of those is a behavior no caller-level test would catch.
 */
import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'os';

import {
  PROBE_TIMEOUT_MS,
  collectFacts,
  defaultProbes,
  formatReport,
  portBlock,
  runDoctor,
  runProbe,
  summarize,
} from './doctor.js';

const fact = (name, status, { required = true } = {}) => ({ name, status, detail: '', required });

describe('summarize', () => {
  it('is ok only when every required fact is available', () => {
    expect(summarize([fact('a', 'available'), fact('b', 'available')]).ok).toBe(true);
    expect(summarize([fact('a', 'available'), fact('b', 'unavailable')]).ok).toBe(false);
  });

  it('never lets an optional fact fail the run', () => {
    // The cert, gh, the media toolchain and the port block are all reported but
    // none of them stops PortOS from booting — see the probe list.
    const report = summarize([
      fact('postgres', 'available'),
      fact('tls-cert', 'unavailable', { required: false }),
      fact('ports', 'unavailable', { required: false }),
    ]);
    expect(report.ok).toBe(true);
  });

  it('is ok on an empty fact list rather than throwing', () => {
    expect(summarize([]).ok).toBe(true);
  });
});

describe('runProbe', () => {
  it('turns a thrown probe into an unavailable fact instead of rejecting', async () => {
    const result = await runProbe({
      name: 'postgres',
      run: () => { throw new Error('connection refused'); },
    });
    expect(result).toMatchObject({ name: 'postgres', status: 'unavailable', required: true });
    expect(result.detail).toContain('connection refused');
  });

  it('turns a rejected async probe into an unavailable fact', async () => {
    const result = await runProbe({ name: 'x', run: async () => { throw new Error('boom'); } });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('boom');
  });

  it('times out a probe that never settles rather than hanging the report', async () => {
    // Injected time, not a production sleep: the point is the state machine,
    // and a real 12s wait in the suite would be the actual defect.
    vi.useFakeTimers();
    try {
      const pending = runProbe({ name: 'hung', timeoutMs: 1_000, run: () => new Promise(() => {}) });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.status).toBe('unavailable');
      expect(result.detail).toContain('timed out after 1000ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrubs the home-directory prefix out of the detail it reports', async () => {
    // The whole value proposition is a block the user pastes into a bug report,
    // and a thrown ENOENT embeds an absolute path — so the username must be
    // gone before the fact is built, not at print time.
    const home = homedir();
    const result = await runProbe({
      name: 'deps:server',
      run: () => { throw new Error(`ENOENT: no such file ${home}/github.com/example/server/node_modules`); },
    });
    expect(result.detail).not.toContain(home);
    expect(result.detail).toContain('~/github.com/example/server/node_modules');
  });

  it('defaults a probe to required, and honors an explicit required:false', async () => {
    const available = async () => ({ available: true, detail: 'ok' });
    expect((await runProbe({ name: 'a', run: available })).required).toBe(true);
    expect((await runProbe({ name: 'b', required: false, run: available })).required).toBe(false);
  });

  it('reports a probe that returns nothing as unavailable with an empty detail', async () => {
    const result = await runProbe({ name: 'silent', run: async () => undefined });
    expect(result).toMatchObject({ status: 'unavailable', detail: '' });
  });
});

describe('collectFacts', () => {
  it('keeps probe-list order regardless of completion order, so two runs diff cleanly', async () => {
    const slow = { name: 'slow', run: () => new Promise((r) => setTimeout(() => r({ available: true, detail: '' }), 20)) };
    const fast = { name: 'fast', run: async () => ({ available: true, detail: '' }) };
    const facts = await collectFacts([slow, fast]);
    expect(facts.map((f) => f.name)).toEqual(['slow', 'fast']);
  });
});

describe('formatReport', () => {
  it('names every missing required fact in the closing line', () => {
    const out = formatReport(summarize([
      fact('postgres', 'unavailable'),
      fact('migrations', 'unavailable'),
      fact('node', 'available'),
    ]));
    expect(out).toContain('2 required prerequisites unavailable: postgres, migrations');
  });

  it('marks an unavailable optional fact as a warning, not a failure', () => {
    const out = formatReport(summarize([fact('tls-cert', 'unavailable', { required: false })]));
    expect(out).toContain('⚠️');
    expect(out).not.toContain('❌');
    expect(out).toContain('All required prerequisites are available');
  });
});

describe('portBlock', () => {
  it('returns only the PortOS-owned 5553-5561 block, deduped and sorted', () => {
    // PORTS also carries whisper/llama/vLLM ports the operator starts by hand,
    // and lists POSTGRES twice (its own key plus the docker one).
    const ports = portBlock();
    expect(ports.length).toBeGreaterThan(0);
    expect(ports).toEqual([...new Set(ports)].sort((a, b) => a - b));
    expect(ports.every((p) => p >= 5553 && p <= 5561)).toBe(true);
    expect(ports).toContain(5555);
  });
});

describe('defaultProbes', () => {
  it('gives every prerequisite a unique name and a runnable probe', () => {
    const probes = defaultProbes();
    expect(new Set(probes.map((p) => p.name)).size).toBe(probes.length);
    expect(probes.every((p) => typeof p.run === 'function')).toBe(true);
  });

  it('requires the boot-blocking prerequisites and leaves the rest advisory', () => {
    const required = Object.fromEntries(defaultProbes().map((p) => [p.name, p.required]));
    // Without these the server cannot start.
    expect(required).toMatchObject({
      node: true,
      'submodule:slashdo': true,
      'deps:server': true,
      'data:seeded': true,
      postgres: true,
      'postgres:pgvector': true,
      migrations: true,
    });
    // These do not block boot. `ports` in particular is advisory on purpose: a
    // running install legitimately occupies the block, and failing on that
    // would make doctor exit 1 on every healthy machine.
    expect(required).toMatchObject({ npm: false, ffmpeg: false, gh: false, 'tls-cert': false, ports: false });
  });
});

describe('runDoctor', () => {
  it('prints parseable JSON and exits 0 when every required fact is available', async () => {
    const log = vi.fn();
    const result = await runDoctor({
      probes: [
        { name: 'node', run: async () => ({ available: true, detail: 'v24' }) },
        { name: 'gh', required: false, run: async () => ({ available: false, detail: 'not authenticated' }) },
      ],
      json: true,
      log,
    });
    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(log.mock.calls[0][0]);
    expect(printed.ok).toBe(true);
    expect(printed.facts).toHaveLength(2);
    expect(printed.facts[0]).toEqual({ name: 'node', status: 'available', detail: 'v24', required: true });
  });

  it('exits 1 when a required fact is unavailable, and still prints the whole report', async () => {
    const log = vi.fn();
    const result = await runDoctor({
      probes: [
        { name: 'postgres', run: async () => ({ available: false, detail: 'unreachable' }) },
        { name: 'node', run: async () => ({ available: true, detail: 'v24' }) },
      ],
      log,
    });
    expect(result.exitCode).toBe(1);
    expect(log.mock.calls[0][0]).toContain('postgres');
    expect(log.mock.calls[0][0]).toContain('node');
  });

  it('bounds each probe by default so one hung prerequisite cannot hang the report', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
