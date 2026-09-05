/**
 * The `codex exec --help` flag probe (#6305) — the gate that keeps a
 * local-backed Codex row from spawning against a CLI that has never heard of
 * `--oss`.
 *
 * What matters here is the tri-state, not the parsing: "could not run it" and
 * "ran it and the flags are absent" must never collapse, because the first is
 * NOT PROBED (route normally) and the second is a definite negative (skip).
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  __resetCodexOssSupport,
  getCodexOssSupport,
  peekCodexOssSupport,
} from './codexOssSupport.js';

const HELP_WITH_OSS = `Usage: codex exec [OPTIONS] [PROMPT]
      --oss
          Use open-source provider
      --local-provider <OSS_PROVIDER>
          Specify which local provider to use (lmstudio or ollama)`;
const HELP_WITHOUT_OSS = 'Usage: codex exec [OPTIONS] [PROMPT]\n  -m, --model <MODEL>';

describe('codexOssSupport', () => {
  beforeEach(() => __resetCodexOssSupport());

  it('reports supported when the help text names BOTH flags', async () => {
    expect(await getCodexOssSupport('codex', { run: async () => HELP_WITH_OSS })).toEqual({ supported: true });
  });

  it('reports unsupported when the help text was read and does not name them', async () => {
    expect(await getCodexOssSupport('codex', { run: async () => HELP_WITHOUT_OSS })).toEqual({ supported: false });
  });

  it('requires both flags — one without the other is not the contract', async () => {
    const partial = 'Usage: codex exec\n      --oss\n          Use open-source provider';
    expect(await getCodexOssSupport('codex', { run: async () => partial })).toEqual({ supported: false });
  });

  it('answers NOT PROBED when the probe could not run, and does not cache it', async () => {
    const run = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(HELP_WITH_OSS);
    // A binary that isn't there is the runtime table's finding, not this one's:
    // caching `false` here would blame a perfectly good provider for a
    // transient spawn failure until the TTL expired.
    expect(await getCodexOssSupport('codex', { run })).toBeNull();
    expect(peekCodexOssSupport('codex')).toBeNull();
    expect(await getCodexOssSupport('codex', { run })).toEqual({ supported: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('caches per command, so a probe of one binary never answers for another', async () => {
    const run = vi.fn(async (command) => (command === '/opt/old/codex' ? HELP_WITHOUT_OSS : HELP_WITH_OSS));
    expect(await getCodexOssSupport('codex', { run })).toEqual({ supported: true });
    expect(await getCodexOssSupport('/opt/old/codex', { run })).toEqual({ supported: false });
    expect(peekCodexOssSupport('codex')).toEqual({ supported: true });
    expect(peekCodexOssSupport('/opt/old/codex')).toEqual({ supported: false });
  });

  it('serves a cached verdict without re-spawning, and coalesces concurrent probes', async () => {
    let resolveHelp;
    const run = vi.fn(() => new Promise((resolve) => { resolveHelp = resolve; }));
    const [a, b] = [getCodexOssSupport('codex', { run }), getCodexOssSupport('codex', { run })];
    resolveHelp(HELP_WITH_OSS);
    expect(await a).toEqual({ supported: true });
    expect(await b).toEqual({ supported: true });
    await getCodexOssSupport('codex', { run });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('peeks nothing before anything has been probed', () => {
    expect(peekCodexOssSupport('codex')).toBeNull();
  });
});
