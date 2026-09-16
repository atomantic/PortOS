/**
 * This resolver is what keeps an HTTP-supplied contribution id from becoming an
 * import path, and it is the single registry the CLI and the promote path must
 * agree on. Both properties are structural, so they get a test.
 */
import { describe, expect, it } from 'vitest';
import { findContributionById, listContributionModulePaths, loadContributionModule } from './eidoverseResilienceContributions.js';

describe('resilience-assay contribution registry', () => {
  it('registers only *.contribution.js, so the deliberately-failing fixture is not promotable', async () => {
    const paths = await listContributionModulePaths();

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.endsWith('.contribution.js'))).toBe(true);
    expect(paths.some((path) => path.includes('narratedOnly'))).toBe(false);
  });

  it('resolves by id and reports a miss instead of importing what the caller named', async () => {
    expect((await findContributionById('beacon-relay-demo')).id).toBe('beacon-relay-demo');
    // The shapes an id can never resolve to — a path is data here, not a module.
    expect(await findContributionById('../../../etc/passwd')).toBeNull();
    expect(await findContributionById('eidoverseResilienceAssayFixtures/narratedOnly.failing.fixture.js')).toBeNull();
  });

  it('refuses an ordinary multi-export module rather than calling its first function', async () => {
    const [firstPath] = await listContributionModulePaths();
    const notAContribution = `${firstPath.replace(/[^/\\]+$/, '')}../eidoverseResilienceContributions.js`;

    await expect(loadContributionModule(notAContribution)).rejects.toThrow(/exactly one named function/);
  });
});
