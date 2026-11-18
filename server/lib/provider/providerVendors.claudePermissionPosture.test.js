// #10419: a Claude provider that pins its own permission posture must not also
// get the default `--dangerously-skip-permissions`, which would override it.
import { describe, expect, it } from 'vitest';
import { buildVendorSpawnConfig } from './providerVendors.js';

const claude = (args) => ({ id: 'claude-code', type: 'cli', command: 'claude', args });
const spawnArgs = (provider) => buildVendorSpawnConfig(provider, { effectiveModel: null }).args;

describe('claude spawn permission posture', () => {
  it('keeps the default bypass when the provider pins no posture', () => {
    expect(spawnArgs(claude([]))).toContain('--dangerously-skip-permissions');
  });

  it.each([
    [['--permission-mode', 'auto']],
    [['--permission-mode=auto']],
    [['--dangerously-skip-permissions']],
    [['--allow-dangerously-skip-permissions']],
  ])('does not inject the bypass when args are %j', (args) => {
    const out = spawnArgs(claude(args));
    expect(out.filter((a) => a === '--dangerously-skip-permissions').length).toBe(args[0] === '--dangerously-skip-permissions' ? 1 : 0);
    for (const a of args) expect(out).toContain(a);
  });
});
