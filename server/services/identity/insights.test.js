import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { goalHorizonEnum } from '../../lib/identityValidation.js';
import { GOAL_HORIZON_YEARS } from './goalHorizons.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'identity-insights-test-'));
const IDENTITY_DIR = join(TEST_DATA_ROOT, 'digital-twin');

vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: TEST_DATA_ROOT,
    extraOverrides: () => ({ digitalTwin: IDENTITY_DIR }),
  }));

const { getCrossInsights } = await import('./insights.js');
const { CHRONOTYPE_FILE, LONGEVITY_FILE, GOALS_FILE } = await import('./store.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

function birthDateWithYearsRemaining(yearsRemaining) {
  const birthDate = new Date();
  birthDate.setUTCFullYear(birthDate.getUTCFullYear() - (85 - yearsRemaining));
  return birthDate.toISOString().slice(0, 10);
}

async function timelineInsight(horizons, yearsRemaining) {
  mkdirSync(IDENTITY_DIR, { recursive: true });
  writeFileSync(CHRONOTYPE_FILE, JSON.stringify({}));
  writeFileSync(LONGEVITY_FILE, JSON.stringify({ lifeExpectancy: { adjusted: 85 }, derivedAt: '2026-01-01T00:00:00.000Z' }));
  writeFileSync(GOALS_FILE, JSON.stringify({
    birthDate: birthDateWithYearsRemaining(yearsRemaining),
    goals: horizons.map(([title, horizon]) => ({ title, horizon, status: 'active' }))
  }));
  const result = await getCrossInsights();
  return result.insights.find(({ id }) => id === 'longevity-goal-urgency');
}

beforeEach(() => {
  rmSync(IDENTITY_DIR, { recursive: true, force: true });
});

describe('longevity goal timeline insight', () => {
  it('keeps the shared duration map aligned with every schema horizon', () => {
    expect(Object.keys(GOAL_HORIZON_YEARS).sort()).toEqual([...goalHorizonEnum.options].sort());
  });

  it('does not warn about a 20-year goal with about 54 years remaining', async () => {
    const insight = await timelineInsight([['Build a community garden', '20-year']], 54);

    expect(insight).toMatchObject({ severity: 'info', title: 'Goal Timeline' });
  });

  it('warns about a 20-year goal with about 10 years remaining', async () => {
    const insight = await timelineInsight([['Finish the memoir', '20-year']], 10);

    expect(insight).toMatchObject({ severity: 'warning', title: 'Goal Timeline Pressure' });
    expect(insight.text).toContain('Finish the memoir');
  });

  it('does not warn about a lifetime goal, alone or beside an at-risk goal', async () => {
    const lifetimeOnly = await timelineInsight([['Support the next generation', 'lifetime']], 10);
    expect(lifetimeOnly).toMatchObject({ severity: 'info', title: 'Goal Timeline' });

    const mixed = await timelineInsight([
      ['Support the next generation', 'lifetime'],
      ['Finish the memoir', '10-year']
    ], 10);
    expect(mixed).toMatchObject({ severity: 'warning', title: 'Goal Timeline Pressure' });
    expect(mixed.text).toContain('Finish the memoir');
    expect(mixed.text).not.toContain('Support the next generation');
  });

  it('uses the shared five-year fallback for an unrecognized stored horizon', async () => {
    const insight = await timelineInsight([['Unrecognized legacy goal', 'unknown-horizon']], 54);

    expect(insight).toMatchObject({ severity: 'info', title: 'Goal Timeline' });
  });
});
