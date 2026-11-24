import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { buildLocalReviewShell } from './localReviewBridge.js';

const run = (pipeline) => spawnSync('bash', ['-c', buildLocalReviewShell(pipeline)], { encoding: 'utf8' });
const bridge = (json, code = 0) => `jq -Rs '{diff: .}' | { cat >/dev/null; printf '%s' '${json}'; exit ${code}; }`;

describe('buildLocalReviewShell', () => {
  it('has no temp-file or trap cleanup', () => {
    const shell = buildLocalReviewShell('x');
    expect(shell).not.toMatch(/mktemp|trap/);
  });

  it('prints findings for a clean reply', () => {
    const r = run(`echo diff | ${bridge('{"ok":true,"verdict":"clean","findings":"all good"}')}`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('all good\n');
  });

  it('fails with the reported error for an ok:false reply', () => {
    const r = run(`echo diff | ${bridge('{"ok":false,"error":"boom"}')}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Local reviewer failed: boom');
  });

  it('fails for a malformed reply', () => {
    const r = run(`echo diff | ${bridge('not json')}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Local reviewer failed');
    expect(r.stdout).toBe('');
  });

  it('fails when the diff command fails even if the bridge replies clean', () => {
    const r = run(`{ false; } | ${bridge('{"ok":true,"verdict":"clean","findings":"all good"}')}`);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
});
