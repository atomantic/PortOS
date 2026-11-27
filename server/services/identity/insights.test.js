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

async function crossInsight(id, { chronotype = {}, longevity = {}, goals = {} } = {}) {
  mkdirSync(IDENTITY_DIR, { recursive: true });
  writeFileSync(CHRONOTYPE_FILE, JSON.stringify(chronotype));
  writeFileSync(LONGEVITY_FILE, JSON.stringify(longevity));
  writeFileSync(GOALS_FILE, JSON.stringify({ goals: [], ...goals }));
  const result = await getCrossInsights();
  return result.insights.find(insight => insight.id === id);
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

describe('cross-domain insights', () => {
  it('distinguishes slow caffeine metabolism from typical markers and requires marker data plus a cutoff', async () => {
    const common = { derivedAt: '2026-01-01T00:00:00.000Z', recommendations: { caffeineCutoff: '2 PM' } };
    const slow = await crossInsight('caffeine-chronotype', {
      chronotype: { ...common, caffeineMarkers: { cyp1a2: { rsid: 'rs762551', status: 'concern' } } }
    });
    expect(slow).toMatchObject({ severity: 'warning', title: 'Caffeine Sensitivity', markers: ['rs762551'] });

    const typical = await crossInsight('caffeine-chronotype', {
      chronotype: { ...common, caffeineMarkers: { ada: { rsid: 'rs73598374', status: 'typical' } } }
    });
    expect(typical).toMatchObject({ severity: 'info', title: 'Caffeine Timing' });

    expect(await crossInsight('caffeine-chronotype', {
      chronotype: { ...common, caffeineMarkers: {} }
    })).toBeUndefined();
    expect(await crossInsight('caffeine-chronotype', {
      chronotype: { ...common, recommendations: {}, caffeineMarkers: { cyp1a2: { status: 'concern' } } }
    })).toBeUndefined();
  });

  it('only flags MTNR1B late eating for a concern marker with a meal cutoff', async () => {
    const concern = await crossInsight('mtnr1b-meal-timing', {
      chronotype: { recommendations: { lastMealCutoff: '7 PM' }, geneticMarkers: { mtnr1b: { status: 'concern', genotype: 'AG', rsid: 'rs10830963' } } }
    });
    expect(concern).toMatchObject({ severity: 'warning', markers: ['rs10830963'] });

    expect(await crossInsight('mtnr1b-meal-timing', {
      chronotype: { recommendations: { lastMealCutoff: '7 PM' }, geneticMarkers: { mtnr1b: { status: 'typical' } } }
    })).toBeUndefined();
    expect(await crossInsight('mtnr1b-meal-timing', {
      chronotype: { geneticMarkers: { mtnr1b: { status: 'concern' } } }
    })).toBeUndefined();
  });

  it('shows peak focus at confidence 0.3 and suppresses it below that threshold', async () => {
    const insight = await crossInsight('chronotype-deep-work', {
      chronotype: { confidence: 0.3, recommendations: { peakFocusStart: '9 AM', peakFocusEnd: 'noon' } }
    });
    expect(insight).toMatchObject({ severity: 'info', title: 'Peak Focus Window' });
    expect(await crossInsight('chronotype-deep-work', {
      chronotype: { confidence: 0.29, recommendations: { peakFocusStart: '9 AM', peakFocusEnd: 'noon' } }
    })).toBeUndefined();
  });

  it('reports positive and negative life-expectancy adjustments with matching severity', async () => {
    const favorable = await crossInsight('longevity-overview', {
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z', confidence: 0.5, lifeExpectancy: { longevityAdjustment: 2, cardiovascularAdjustment: 1, adjusted: 81 } }
    });
    expect(favorable).toMatchObject({ severity: 'success', title: 'Genetic Life Expectancy' });
    expect(favorable.text).toContain('+3 years');

    const unfavorable = await crossInsight('longevity-overview', {
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z', confidence: 0.5, lifeExpectancy: { longevityAdjustment: -2, cardiovascularAdjustment: 0, adjusted: 76.5 } }
    });
    expect(unfavorable).toMatchObject({ severity: 'warning', title: 'Genetic Life Expectancy' });
    expect(unfavorable.text).toContain('-2 years');
    expect(await crossInsight('longevity-overview', {
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z', confidence: 0.49, lifeExpectancy: { longevityAdjustment: 2 } }
    })).toBeUndefined();
  });

  it('fires inflammation for either concern marker and describes zero, one, or multiple active health goals', async () => {
    const withGoal = async (markers, goals) => crossInsight('inflammation-health-goals', {
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z', cardiovascularMarkers: markers },
      goals: { goals }
    });
    const il6Only = await withGoal({ il6: { status: 'concern', genotype: 'AG', rsid: 'rs1800795' } }, []);
    expect(il6Only.text).toContain('IL-6 (AG)');
    expect(il6Only.text).toContain('Consider adding health goals');

    const tnfaOnly = await withGoal({ tnfa: { status: 'concern', genotype: 'GG', rsid: 'rs1800629' } }, [
      { category: 'health', status: 'active' }
    ]);
    expect(tnfaOnly.text).toContain('TNF-alpha (GG)');
    expect(tnfaOnly.text).toContain('1 active health goal aligns');

    const both = await withGoal({
      il6: { status: 'concern', genotype: 'AG' }, tnfa: { status: 'concern', genotype: 'GG' }
    }, [{ category: 'health', status: 'active' }, { category: 'health', status: 'active' }]);
    expect(both.text).toContain('2 active health goals align');
    expect(await withGoal({ il6: { status: 'typical' }, tnfa: { status: 'typical' } }, [])).toBeUndefined();
  });

  it.each([
    ['foxo3a-longevity', 'foxo3a', 'FOXO3A Longevity Variant'],
    ['terc-telomere', 'terc', 'Telomere Length']
  ])('emits %s only for a concern marker', async (id, markerKey, title) => {
    const concern = await crossInsight(id, {
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z', longevityMarkers: { [markerKey]: { status: 'concern', genotype: 'AG', rsid: 'rs-example' } } }
    });
    expect(concern).toMatchObject({ severity: 'warning', title, markers: ['rs-example'] });
    expect(await crossInsight(id, {
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z', longevityMarkers: { [markerKey]: { status: 'typical' } } }
    })).toBeUndefined();
  });

  it('requires two beneficial cardiovascular markers and reflects available data sources', async () => {
    const oneBeneficial = await crossInsight('cardiovascular-protection', {
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z', cardiovascularMarkers: {
        il6: { status: 'beneficial', gene: 'IL6', rsid: 'rs-one' }, tnfa: { status: 'typical', gene: 'TNFA' }
      } }
    });
    expect(oneBeneficial).toBeUndefined();

    const twoBeneficial = await crossInsight('cardiovascular-protection', {
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z', cardiovascularMarkers: {
        il6: { status: 'beneficial', gene: 'IL6', rsid: 'rs-one' }, tnfa: { status: 'beneficial', gene: 'TNFA', rsid: 'rs-two' }
      } }
    });
    expect(twoBeneficial).toMatchObject({ severity: 'success', markers: ['rs-one', 'rs-two'] });

    const result = await getCrossInsights();
    expect(result.dataSources).toEqual({ chronotype: false, longevity: true, goals: false });

    await crossInsight('cardiovascular-protection');
    expect((await getCrossInsights()).dataSources).toEqual({ chronotype: false, longevity: false, goals: false });

    await crossInsight('cardiovascular-protection', {
      chronotype: { derivedAt: '2026-01-01T00:00:00.000Z' },
      longevity: { derivedAt: '2026-01-01T00:00:00.000Z' },
      goals: { goals: [{ id: 'goal-1' }] }
    });
    expect((await getCrossInsights()).dataSources).toEqual({ chronotype: true, longevity: true, goals: true });
  });
});
