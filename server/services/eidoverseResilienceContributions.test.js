/**
 * This resolver is what keeps an HTTP-supplied contribution id from becoming an
 * import path, and it is the single registry the CLI and the promote path must
 * agree on. Both properties are structural, so they get a test.
 */
import { describe, expect, it } from 'vitest';
import { findContributionById, listContributionModulePaths, listRegisteredContributionIds, loadContributionModule } from './eidoverseResilienceContributions.js';
import { runResilienceAssay } from './eidoverseResilienceAssay.js';
import { listControllerDefinitionIds } from './eidoverseControllerRegistry.js';

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

  // #7456's integration point: the executable-controller registry is a SECOND
  // source behind this same resolver, so a `controller` foundation can name
  // its controller's id as its contributionId and be gated on evidence that
  // the controller still runs with its author gone. Neither the CLI nor the
  // promote path changed shape to gain it.
  it('resolves an executable world controller by id, from the second source', async () => {
    const controllerIds = await listControllerDefinitionIds();
    expect(controllerIds.length).toBeGreaterThan(0);

    const registered = await listRegisteredContributionIds();
    expect(registered).toEqual(expect.arrayContaining(['beacon-relay-demo', ...controllerIds]));

    for (const id of controllerIds) {
      const contribution = await findContributionById(id);
      expect(contribution.id).toBe(id);
      // Every shipped controller must survive the agent-free assay — a
      // controller PortOS ships that cannot outlive its author is not a
      // controller, it is a script.
      expect(runResilienceAssay(contribution)).toMatchObject({ pass: true, reasons: [] });
    }
  });
});
