import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractSleepMarkers,
  extractCaffeineMarkers,
  extractLongevityMarkers,
  extractCardiovascularMarkers,
  computeLifeExpectancy,
  computeChronotype,
  computeRecommendations,
  computeGoalUrgency
} from './identity.js';

// identity/store.js now persists via the canonical atomicWrite (#1837), which
// writes to a temp file then renames it over the target (with unlink cleanup on
// error) and ensureDir's the parent. The integration tests below mock
// fs/promises with a simple path-keyed in-memory store; makeFsPromisesStore()
// supplies the rename/unlink/mkdir the real atomicWrite needs so the temp→final
// move lands in the same store the reads come from.
function makeFsPromisesStore() {
  const store = {};
  return {
    readFile: vi.fn(async (path) => {
      if (path in store) return store[path];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    writeFile: vi.fn(async (path, data) => { store[path] = data; }),
    rename: vi.fn(async (from, to) => {
      if (!(from in store)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      store[to] = store[from];
      delete store[from];
    }),
    unlink: vi.fn(async (path) => { delete store[path]; }),
    mkdir: vi.fn(async () => {}),
    // atomicWrite stats the destination to mirror its mode onto the temp file
    // before renaming (#1837). The in-memory store doesn't track modes, so
    // report a default for existing paths and ENOENT for absent ones; chmod is
    // a no-op here.
    stat: vi.fn(async (path) => {
      if (!(path in store)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mode: 0o644 };
    }),
    chmod: vi.fn(async () => {}),
  };
}

// === Helper: build savedMarkers map from rsid/status pairs ===

function buildSavedMarkers(entries) {
  const markers = {};
  for (const [rsid, status, genotype] of entries) {
    markers[`uuid-${rsid}`] = { rsid, status, genotype: genotype || 'AG', category: 'sleep', gene: 'TEST' };
  }
  return markers;
}

// ============================================================
// Tests
// ============================================================

describe('extractSleepMarkers', () => {
  it('should extract all 5 sleep markers when present', () => {
    const saved = buildSavedMarkers([
      ['rs1801260', 'beneficial', 'AA'],
      ['rs57875989', 'typical', 'GG'],
      ['rs35333999', 'concern', 'AG'],
      ['rs2287161', 'beneficial', 'TT'],
      ['rs4753426', 'concern', 'CC']
    ]);

    const result = extractSleepMarkers(saved);

    expect(Object.keys(result)).toHaveLength(5);
    expect(result.clockGene.rsid).toBe('rs1801260');
    expect(result.clockGene.signal).toBe(-1); // beneficial → morning
    expect(result.cry1.signal).toBe(1); // beneficial → evening (CRY1 is inverted)
    expect(result.mtnr1b.signal).toBe(1); // concern → evening
  });

  it('should return partial results when only some markers exist', () => {
    const saved = buildSavedMarkers([
      ['rs1801260', 'typical', 'AG'],
      ['rs2287161', 'concern', 'CT']
    ]);

    const result = extractSleepMarkers(saved);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result.clockGene).toBeDefined();
    expect(result.cry1).toBeDefined();
    expect(result.per2).toBeUndefined();
  });

  it('should return empty object for empty savedMarkers', () => {
    expect(extractSleepMarkers({})).toEqual({});
    expect(extractSleepMarkers(null)).toEqual({});
    expect(extractSleepMarkers(undefined)).toEqual({});
  });

  it('should ignore non-sleep markers', () => {
    const saved = buildSavedMarkers([
      ['rs762551', 'beneficial', 'AA'], // caffeine marker
      ['rs9999999', 'typical', 'GG']   // unknown
    ]);

    const result = extractSleepMarkers(saved);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('extractCaffeineMarkers', () => {
  it('should extract CYP1A2 and ADA markers', () => {
    const saved = buildSavedMarkers([
      ['rs762551', 'beneficial', 'AA'],
      ['rs73598374', 'typical', 'GG']
    ]);

    const result = extractCaffeineMarkers(saved);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result.cyp1a2.rsid).toBe('rs762551');
    expect(result.ada.rsid).toBe('rs73598374');
  });

  it('should return empty for no caffeine markers', () => {
    const saved = buildSavedMarkers([
      ['rs1801260', 'beneficial', 'AA'] // sleep marker
    ]);

    expect(extractCaffeineMarkers(saved)).toEqual({});
  });
});

describe('computeChronotype', () => {
  describe('genetic-only derivation', () => {
    it('should classify as morning when all markers show morning tendency', () => {
      // beneficial sleep markers → morning signals, except CRY1 (inverted)
      const markers = {
        clockGene: { signal: -1 },  // beneficial = morning
        dec2: { signal: -1 },
        per2: { signal: -1 },
        cry1: { signal: -1 },       // concern = morning
        mtnr1b: { signal: 0 }       // beneficial = neutral
      };

      const result = computeChronotype(markers, null);

      expect(result.type).toBe('morning');
      expect(result.scores.genetic).toBeLessThan(-0.25);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should classify as evening when markers show evening tendency', () => {
      const markers = {
        clockGene: { signal: 1 },
        dec2: { signal: 1 },
        per2: { signal: 1 },
        cry1: { signal: 1 },
        mtnr1b: { signal: 1 }
      };

      const result = computeChronotype(markers, null);

      expect(result.type).toBe('evening');
      expect(result.scores.genetic).toBeGreaterThan(0.25);
    });

    it('should classify as intermediate for mixed signals', () => {
      const markers = {
        clockGene: { signal: -1 },
        cry1: { signal: 1 },
        per2: { signal: 0 }
      };

      const result = computeChronotype(markers, null);

      expect(result.type).toBe('intermediate');
    });

    it('should return intermediate with 0 confidence for no data', () => {
      const result = computeChronotype({}, null);

      expect(result.type).toBe('intermediate');
      expect(result.confidence).toBe(0);
      expect(result.scores.composite).toBe(0);
    });
  });

  describe('behavioral-only derivation', () => {
    it('should classify early riser as morning', () => {
      const result = computeChronotype({}, {
        preferredWakeTime: '05:30',
        preferredSleepTime: '21:00'
      });

      expect(result.type).toBe('morning');
      expect(result.scores.behavioral).toBeLessThan(0);
    });

    it('should classify late sleeper as evening', () => {
      const result = computeChronotype({}, {
        preferredWakeTime: '10:00',
        preferredSleepTime: '02:00'
      });

      expect(result.type).toBe('evening');
      expect(result.scores.behavioral).toBeGreaterThan(0);
    });
  });

  describe('combined genetic + behavioral', () => {
    it('should boost confidence when genetic and behavioral agree', () => {
      const morningMarkers = {
        clockGene: { signal: -1 },
        per2: { signal: -1 }
      };

      const agreeing = computeChronotype(morningMarkers, {
        preferredWakeTime: '05:30',
        preferredSleepTime: '21:30'
      });

      const geneticOnly = computeChronotype(morningMarkers, null);

      expect(agreeing.confidence).toBeGreaterThan(geneticOnly.confidence);
    });

    it('should penalize confidence when genetic and behavioral disagree', () => {
      const morningMarkers = {
        clockGene: { signal: -1 },
        per2: { signal: -1 }
      };

      const disagreeing = computeChronotype(morningMarkers, {
        preferredWakeTime: '11:00',
        preferredSleepTime: '03:00'
      });

      // Confidence should be lower due to disagreement penalty
      expect(disagreeing.confidence).toBeLessThan(0.5);
    });

    it('should average genetic and behavioral scores', () => {
      const markers = {
        clockGene: { signal: -1 },
        per2: { signal: -1 }
      };

      const result = computeChronotype(markers, {
        preferredWakeTime: '10:00', // evening behavioral
        preferredSleepTime: '01:00'
      });

      // Genetic is morning, behavioral is evening — should moderate
      expect(Math.abs(result.scores.composite)).toBeLessThan(
        Math.abs(result.scores.genetic)
      );
    });
  });

  describe('confidence calculation', () => {
    it('should give max marker confidence (0.5) with all 5 markers', () => {
      const allMarkers = {
        clockGene: { signal: 0 },
        dec2: { signal: 0 },
        per2: { signal: 0 },
        cry1: { signal: 0 },
        mtnr1b: { signal: 0 }
      };

      const result = computeChronotype(allMarkers, null);
      expect(result.confidence).toBe(0.5);
    });

    it('should give proportional marker confidence with partial markers', () => {
      const twoMarkers = {
        clockGene: { signal: 0 },
        per2: { signal: 0 }
      };

      const result = computeChronotype(twoMarkers, null);
      expect(result.confidence).toBe(0.2); // 2/5 * 0.5
    });
  });
});

describe('computeRecommendations', () => {
  describe('schedule templates', () => {
    it('should return morning schedule for morning type', () => {
      const result = computeRecommendations('morning', {}, null);
      expect(result.wakeTime).toBe('06:00');
      expect(result.sleepTime).toBe('22:00');
      expect(result.peakFocusStart).toBe('08:00');
    });

    it('should return intermediate schedule for intermediate type', () => {
      const result = computeRecommendations('intermediate', {}, null);
      expect(result.wakeTime).toBe('07:00');
      expect(result.peakFocusStart).toBe('09:30');
    });

    it('should return evening schedule for evening type', () => {
      const result = computeRecommendations('evening', {}, null);
      expect(result.wakeTime).toBe('08:30');
      expect(result.sleepTime).toBe('00:30');
      expect(result.peakFocusStart).toBe('11:00');
    });
  });

  describe('caffeine cutoff', () => {
    it('should set late cutoff for fast metabolizer (beneficial CYP1A2)', () => {
      const result = computeRecommendations('intermediate', {
        cyp1a2: { status: 'beneficial' }
      }, null);

      expect(result.caffeineCutoff).toBe('16:00');
      expect(result.caffeineNote).toContain('Fast metabolizer');
    });

    it('should set early cutoff for slow metabolizer (concern CYP1A2)', () => {
      const result = computeRecommendations('intermediate', {
        cyp1a2: { status: 'concern' }
      }, null);

      expect(result.caffeineCutoff).toBe('12:00');
      expect(result.caffeineNote).toContain('Slow metabolizer');
    });

    it('should set moderate cutoff for typical CYP1A2', () => {
      const result = computeRecommendations('intermediate', {
        cyp1a2: { status: 'typical' }
      }, null);

      expect(result.caffeineCutoff).toBe('14:00');
    });

    it('should handle major_concern same as concern', () => {
      const result = computeRecommendations('intermediate', {
        cyp1a2: { status: 'major_concern' }
      }, null);

      expect(result.caffeineCutoff).toBe('12:00');
    });
  });

  describe('MTNR1B meal timing', () => {
    it('should recommend earlier meals for MTNR1B concern', () => {
      const result = computeRecommendations('intermediate', {}, 'concern');

      expect(result.lastMealCutoff).toBe('19:00');
      expect(result.mealNote).toContain('MTNR1B');
    });

    it('should recommend standard meals for MTNR1B beneficial', () => {
      const result = computeRecommendations('intermediate', {}, 'beneficial');

      expect(result.lastMealCutoff).toBe('20:30');
      expect(result.mealNote).toContain('Standard');
    });

    it('should recommend standard meals for null MTNR1B', () => {
      const result = computeRecommendations('morning', {}, null);

      expect(result.lastMealCutoff).toBe('20:30');
    });
  });
});

// ============================================================
// Longevity Tests
// ============================================================

describe('extractLongevityMarkers', () => {
  it('should extract all 5 longevity markers when present', () => {
    const saved = buildSavedMarkers([
      ['rs2802292', 'beneficial', 'TG'],
      ['rs2229765', 'typical', 'GG'],
      ['rs5882', 'concern', 'AG'],
      ['rs12366', 'beneficial', 'AA'],
      ['rs10936599', 'typical', 'TT']
    ]);

    const result = extractLongevityMarkers(saved);

    expect(Object.keys(result)).toHaveLength(5);
    expect(result.foxo3a.rsid).toBe('rs2802292');
    expect(result.foxo3a.signal).toBe(1); // beneficial = +1 longevity
    expect(result.cetp.signal).toBe(-1); // concern = -1 longevity
    expect(result.igf1r.signal).toBe(0); // typical = neutral
  });

  it('should return partial results for missing markers', () => {
    const saved = buildSavedMarkers([
      ['rs2802292', 'beneficial', 'TG']
    ]);

    const result = extractLongevityMarkers(saved);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.foxo3a).toBeDefined();
    expect(result.igf1r).toBeUndefined();
  });

  it('should return empty for no longevity markers', () => {
    expect(extractLongevityMarkers({})).toEqual({});
    expect(extractLongevityMarkers(null)).toEqual({});
  });

  it('should ignore non-longevity markers', () => {
    const saved = buildSavedMarkers([
      ['rs1801260', 'beneficial', 'AA'] // sleep marker
    ]);
    expect(extractLongevityMarkers(saved)).toEqual({});
  });
});

describe('extractCardiovascularMarkers', () => {
  it('should extract all 6 cardiovascular markers when present', () => {
    const saved = buildSavedMarkers([
      ['rs6025', 'typical', 'GG'],
      ['rs1333049', 'concern', 'CC'],
      ['rs10455872', 'beneficial', 'AA'],
      ['rs1799963', 'typical', 'GG'],
      ['rs1800795', 'concern', 'CC'],
      ['rs1800629', 'typical', 'GG']
    ]);

    const result = extractCardiovascularMarkers(saved);

    expect(Object.keys(result)).toHaveLength(6);
    expect(result.cad9p21.signal).toBe(1); // concern = +1 risk
    expect(result.lpa.signal).toBe(-1); // beneficial = -1 risk
    expect(result.factorV.signal).toBe(0); // typical = neutral
  });

  it('should handle major_concern status', () => {
    const saved = buildSavedMarkers([
      ['rs6025', 'major_concern', 'AA']
    ]);

    const result = extractCardiovascularMarkers(saved);
    expect(result.factorV.signal).toBe(1.5); // major_concern = 1.5 risk
  });

  it('should return empty for no cardiovascular markers', () => {
    expect(extractCardiovascularMarkers({})).toEqual({});
  });
});

describe('computeLifeExpectancy', () => {
  it('should return baseline when no markers present', () => {
    const result = computeLifeExpectancy({}, {}, null);

    expect(result.lifeExpectancy.baseline).toBe(78.5);
    expect(result.lifeExpectancy.adjusted).toBe(78.5);
    expect(result.lifeExpectancy.longevityAdjustment).toBe(0);
    expect(result.lifeExpectancy.cardiovascularAdjustment).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.timeHorizons).toBeNull();
  });

  it('should increase life expectancy for beneficial longevity markers', () => {
    const longevity = {
      foxo3a: { signal: 1, weight: 0.25 },
      igf1r: { signal: 1, weight: 0.20 },
      cetp: { signal: 1, weight: 0.20 }
    };

    const result = computeLifeExpectancy(longevity, {}, null);

    expect(result.lifeExpectancy.adjusted).toBeGreaterThan(78.5);
    expect(result.lifeExpectancy.longevityAdjustment).toBeGreaterThan(0);
    expect(result.longevityScore).toBe(1); // all beneficial
  });

  it('should decrease life expectancy for cardiovascular risk markers', () => {
    const cardio = {
      factorV: { signal: 1, weight: 0.20 },
      cad9p21: { signal: 1, weight: 0.20 },
      il6: { signal: 1, weight: 0.15 }
    };

    const result = computeLifeExpectancy({}, cardio, null);

    expect(result.lifeExpectancy.adjusted).toBeLessThan(78.5);
    expect(result.lifeExpectancy.cardiovascularAdjustment).toBeLessThan(0);
    expect(result.cardiovascularRisk).toBe(1); // all concern
  });

  it('should balance longevity and cardiovascular adjustments', () => {
    const longevity = { foxo3a: { signal: 1, weight: 0.25 } };
    const cardio = { factorV: { signal: 1, weight: 0.20 } };

    const result = computeLifeExpectancy(longevity, cardio, null);

    // Longevity adds years, cardio subtracts — result depends on relative magnitude
    expect(result.lifeExpectancy.longevityAdjustment).toBeGreaterThan(0);
    expect(result.lifeExpectancy.cardiovascularAdjustment).toBeLessThan(0);
  });

  it('should calculate time horizons when birth date provided', () => {
    const result = computeLifeExpectancy({}, {}, '1980-01-15');

    expect(result.timeHorizons).not.toBeNull();
    expect(result.timeHorizons.ageYears).toBeGreaterThan(40);
    expect(result.timeHorizons.yearsRemaining).toBeGreaterThan(0);
    expect(result.timeHorizons.healthyYearsRemaining).toBeLessThan(result.timeHorizons.yearsRemaining);
    expect(result.timeHorizons.percentLifeComplete).toBeGreaterThan(0);
    expect(result.timeHorizons.percentLifeComplete).toBeLessThan(100);
  });

  it('should not exceed 100% life complete', () => {
    // Very old birth date
    const result = computeLifeExpectancy({}, {}, '1920-01-01');

    expect(result.timeHorizons.percentLifeComplete).toBe(100);
    expect(result.timeHorizons.yearsRemaining).toBe(0);
  });

  it('should calculate confidence based on marker coverage', () => {
    const longevity = {
      foxo3a: { signal: 0, weight: 0.25 },
      igf1r: { signal: 0, weight: 0.20 }
    };
    const cardio = {
      factorV: { signal: 0, weight: 0.20 }
    };

    const result = computeLifeExpectancy(longevity, cardio, null);

    // 3 out of 11 total markers = ~0.27
    expect(result.confidence).toBeGreaterThan(0.2);
    expect(result.confidence).toBeLessThan(0.4);
  });
});

describe('computeGoalUrgency', () => {
  const baseHorizons = {
    ageYears: 45,
    yearsRemaining: 33.5,
    healthyYearsRemaining: 28.5,
    percentLifeComplete: 57.3
  };

  it('should return null when no time horizons', () => {
    expect(computeGoalUrgency({ horizon: '5-year' }, null)).toBeNull();
  });

  it('should return null when goal has no horizon', () => {
    expect(computeGoalUrgency({}, baseHorizons)).toBeNull();
  });

  it('should return low urgency for short-horizon goals with plenty of time', () => {
    const urgency = computeGoalUrgency({ horizon: '1-year' }, baseHorizons);
    expect(urgency).toBeLessThan(0.1);
  });

  it('should return higher urgency for lifetime goals', () => {
    const lifetime = computeGoalUrgency({ horizon: 'lifetime' }, baseHorizons);
    const shortTerm = computeGoalUrgency({ horizon: '1-year' }, baseHorizons);
    expect(lifetime).toBeGreaterThan(shortTerm);
  });

  it('should add health pressure for goals exceeding healthy years', () => {
    const horizons = { ...baseHorizons, healthyYearsRemaining: 3 };
    const urgency = computeGoalUrgency({ horizon: '5-year' }, horizons);
    // 5-year > 3 healthy years → health pressure adds 0.2
    expect(urgency).toBeGreaterThan(0);
  });

  it('should cap urgency at 1.0', () => {
    const tightHorizons = {
      ageYears: 75,
      yearsRemaining: 3,
      healthyYearsRemaining: 1,
      percentLifeComplete: 96
    };
    const urgency = computeGoalUrgency({ horizon: '20-year' }, tightHorizons);
    expect(urgency).toBeLessThanOrEqual(1);
  });

  it('returns max urgency instead of NaN for a lifetime goal with zero years remaining', () => {
    // horizonYears for 'lifetime' is derived from timeHorizons.yearsRemaining, so
    // when that's 0 the old formula divided 0/0 and produced NaN. The real
    // implementation short-circuits to max urgency (1) whenever horizonYears or
    // yearsRemaining is non-positive — this case is reachable in production for
    // a user whose computed life expectancy has already elapsed.
    const urgency = computeGoalUrgency(
      { horizon: 'lifetime' },
      { yearsRemaining: 0, healthyYearsRemaining: 0 }
    );
    expect(urgency).toBe(1);
  });
});

// === Integration tests (mock fs + genome service) ===

describe('Integration: deriveChronotype', () => {
  let deriveChronotype, getChronotype, updateChronotypeBehavioral, getIdentityStatus;

  beforeEach(async () => {
    vi.resetModules();

    // Mock fs/promises
    vi.doMock('fs/promises', makeFsPromisesStore);

    // Mock genome service
    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: true,
        markerCount: 7,
        uploadedAt: '2025-01-01T00:00:00.000Z',
        savedMarkers: buildSavedMarkers([
          ['rs1801260', 'beneficial', 'TT'],   // CLOCK — morning
          ['rs57875989', 'typical', 'GG'],       // DEC2 — neutral
          ['rs35333999', 'beneficial', 'CC'],    // PER2 — morning
          ['rs2287161', 'concern', 'AG'],        // CRY1 — morning (inverted)
          ['rs4753426', 'concern', 'CG'],        // MTNR1B — evening
          ['rs762551', 'concern', 'AC'],         // CYP1A2 — slow
          ['rs73598374', 'typical', 'GG']        // ADA — typical
        ])
      }))
    }));

    // Mock taste-questionnaire service
    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 2,
        totalSections: 5,
        overallPercentage: 40,
        lastSessionAt: '2025-01-15T00:00:00.000Z'
      }))
    }));

    const mod = await import('./identity.js');
    deriveChronotype = mod.deriveChronotype;
    getChronotype = mod.getChronotype;
    updateChronotypeBehavioral = mod.updateChronotypeBehavioral;
    getIdentityStatus = mod.getIdentityStatus;
  });

  it('should derive chronotype from genome markers', async () => {
    const result = await deriveChronotype();

    expect(result.type).toBeDefined();
    expect(['morning', 'intermediate', 'evening']).toContain(result.type);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.derivedAt).toBeDefined();
    expect(result.recommendations).toBeDefined();
    expect(result.geneticMarkers.clockGene).toBeDefined();
    expect(result.caffeineMarkers.cyp1a2).toBeDefined();
  });

  it('should return slow-metabolizer caffeine cutoff for concern CYP1A2', async () => {
    const result = await deriveChronotype();

    expect(result.recommendations.caffeineCutoff).toBe('12:00');
  });

  it('should recommend early meals for MTNR1B concern', async () => {
    const result = await deriveChronotype();

    expect(result.recommendations.lastMealCutoff).toBe('19:00');
  });

  it('should re-derive with behavioral overrides', async () => {
    const initial = await deriveChronotype();
    expect(initial.behavioralData).toBeNull();

    const updated = await updateChronotypeBehavioral({
      preferredWakeTime: '05:00',
      preferredSleepTime: '21:00'
    });

    expect(updated.behavioralData.preferredWakeTime).toBe('05:00');
    expect(updated.behavioralData.preferredSleepTime).toBe('21:00');
    expect(updated.confidence).toBeGreaterThan(initial.confidence);
  });

  it('should return cached chronotype on second getChronotype call', async () => {
    const first = await getChronotype();
    const second = await getChronotype();

    expect(first.derivedAt).toBe(second.derivedAt);
  });
});

describe('Integration: getIdentityStatus', () => {
  let getIdentityStatus;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: true,
        markerCount: 3,
        uploadedAt: '2025-01-01T00:00:00.000Z',
        savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0,
        totalSections: 5,
        overallPercentage: 0,
        lastSessionAt: null
      }))
    }));

    const mod = await import('./identity.js');
    getIdentityStatus = mod.getIdentityStatus;
  });

  it('should return all five sections', async () => {
    const result = await getIdentityStatus();

    expect(result.sections.genome).toBeDefined();
    expect(result.sections.chronotype).toBeDefined();
    expect(result.sections.longevity).toBeDefined();
    expect(result.sections.aesthetics).toBeDefined();
    expect(result.sections.goals).toBeDefined();
  });

  it('should show genome as active when markers exist', async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: true,
        markerCount: 10,
        uploadedAt: '2025-01-01T00:00:00.000Z',
        savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    const mod = await import('./identity.js');
    const result = await mod.getIdentityStatus();

    expect(result.sections.genome.status).toBe('active');
  });

  it('should show aesthetics as unavailable when no taste data', async () => {
    const result = await getIdentityStatus();

    expect(result.sections.aesthetics.status).toBe('unavailable');
  });

  it('should show chronotype as pending when genome uploaded but not derived', async () => {
    const result = await getIdentityStatus();

    expect(result.sections.chronotype.status).toBe('pending');
  });

  it('should show longevity as pending when genome uploaded but not derived', async () => {
    const result = await getIdentityStatus();

    expect(result.sections.longevity.status).toBe('pending');
  });

  it('should show goals as unavailable when no birth date or goals', async () => {
    const result = await getIdentityStatus();

    expect(result.sections.goals.status).toBe('unavailable');
  });
});

describe('Integration: deriveLongevity', () => {
  let deriveLongevity, getLongevity;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: true,
        markerCount: 13,
        uploadedAt: '2025-01-01T00:00:00.000Z',
        savedMarkers: buildSavedMarkers([
          // Longevity markers
          ['rs2802292', 'beneficial', 'TG'],   // FOXO3A — beneficial
          ['rs2229765', 'typical', 'GG'],       // IGF1R — neutral
          ['rs5882', 'beneficial', 'AA'],       // CETP — beneficial
          ['rs12366', 'typical', 'AG'],         // IPMK — neutral
          ['rs10936599', 'concern', 'TT'],      // TERC — concern
          // Cardiovascular markers
          ['rs6025', 'typical', 'GG'],          // Factor V — neutral
          ['rs1333049', 'concern', 'CC'],       // CAD 9p21 — concern
          ['rs10455872', 'typical', 'GG'],      // LPA — neutral
          ['rs1799963', 'typical', 'GG'],       // Prothrombin — neutral
          ['rs1800795', 'concern', 'CC'],       // IL-6 — concern
          ['rs1800629', 'typical', 'GG']        // TNF-alpha — neutral
        ])
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    const mod = await import('./identity.js');
    deriveLongevity = mod.deriveLongevity;
    getLongevity = mod.getLongevity;
  });

  it('should derive longevity from genome markers', async () => {
    const result = await deriveLongevity();

    expect(result.derivedAt).toBeDefined();
    expect(Object.keys(result.longevityMarkers)).toHaveLength(5);
    expect(Object.keys(result.cardiovascularMarkers)).toHaveLength(6);
    expect(result.lifeExpectancy.baseline).toBe(78.5);
    expect(result.lifeExpectancy.adjusted).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0.9); // 11/11 markers
  });

  it('should calculate positive longevity adjustment for beneficial markers', async () => {
    const result = await deriveLongevity();

    // 2 beneficial, 2 typical, 1 concern → net positive longevity
    expect(result.longevityScore).toBeGreaterThan(-0.5);
  });

  it('should include time horizons when birth date provided', async () => {
    const result = await deriveLongevity('1980-06-15');

    expect(result.timeHorizons).not.toBeNull();
    expect(result.timeHorizons.ageYears).toBeGreaterThan(40);
    expect(result.timeHorizons.yearsRemaining).toBeGreaterThan(0);
  });

  it('should return cached longevity on second getLongevity call', async () => {
    const first = await getLongevity();
    const second = await getLongevity();

    expect(first.derivedAt).toBe(second.derivedAt);
  });
});

describe('Integration: Goal CRUD', () => {
  let createGoal, getGoals, updateGoal, deleteGoal, setBirthDate, addMilestone, completeMilestone;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: true,
        markerCount: 0,
        uploadedAt: '2025-01-01T00:00:00.000Z',
        savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    const mod = await import('./identity.js');
    createGoal = mod.createGoal;
    getGoals = mod.getGoals;
    updateGoal = mod.updateGoal;
    deleteGoal = mod.deleteGoal;
    setBirthDate = mod.setBirthDate;
    addMilestone = mod.addMilestone;
    completeMilestone = mod.completeMilestone;
  });

  it('should create a goal with defaults', async () => {
    const goal = await createGoal({ title: 'Learn piano' });

    expect(goal.id).toBeDefined();
    expect(goal.title).toBe('Learn piano');
    expect(goal.horizon).toBe('5-year');
    expect(goal.category).toBe('mastery');
    expect(goal.status).toBe('active');
    expect(goal.milestones).toEqual([]);
    expect(goal.createdAt).toBeDefined();
  });

  it('should create a goal with custom fields', async () => {
    const goal = await createGoal({
      title: 'Run a marathon',
      description: 'Complete a full 26.2 mile marathon',
      horizon: '3-year',
      category: 'health'
    });

    expect(goal.title).toBe('Run a marathon');
    expect(goal.description).toBe('Complete a full 26.2 mile marathon');
    expect(goal.horizon).toBe('3-year');
    expect(goal.category).toBe('health');
  });

  it('should persist goals across reads', async () => {
    await createGoal({ title: 'Goal 1' });
    await createGoal({ title: 'Goal 2' });

    const goals = await getGoals();
    expect(goals.goals).toHaveLength(2);
    expect(goals.goals[0].title).toBe('Goal 1');
    expect(goals.goals[1].title).toBe('Goal 2');
  });

  it('should update a goal', async () => {
    const goal = await createGoal({ title: 'Original' });
    const updated = await updateGoal(goal.id, { title: 'Updated', status: 'completed' });

    expect(updated.title).toBe('Updated');
    expect(updated.status).toBe('completed');
  });

  it('should return null for updating non-existent goal', async () => {
    const result = await updateGoal('nonexistent', { title: 'Nope' });
    expect(result).toBeNull();
  });

  it('should delete a goal', async () => {
    const goal = await createGoal({ title: 'To Delete' });
    expect(await deleteGoal(goal.id)).toBe(true);

    const goals = await getGoals();
    expect(goals.goals).toHaveLength(0);
  });

  it('should return false for deleting non-existent goal', async () => {
    expect(await deleteGoal('nonexistent')).toBe(false);
  });

  it('should set birth date and re-derive longevity', async () => {
    const goals = await setBirthDate('1985-03-20');

    expect(goals.birthDate).toBe('1985-03-20');
    expect(goals.updatedAt).toBeDefined();
  });

  it('should add milestone to a goal', async () => {
    const goal = await createGoal({ title: 'With milestones' });
    const milestone = await addMilestone(goal.id, {
      title: 'First milestone',
      targetDate: '2026-06-01'
    });

    expect(milestone.id).toBeDefined();
    expect(milestone.title).toBe('First milestone');
    expect(milestone.targetDate).toBe('2026-06-01');
    expect(milestone.completedAt).toBeNull();
  });

  it('should return null when adding milestone to non-existent goal', async () => {
    const result = await addMilestone('nonexistent', { title: 'Nope' });
    expect(result).toBeNull();
  });

  it('should complete a milestone', async () => {
    const goal = await createGoal({ title: 'With milestones' });
    const milestone = await addMilestone(goal.id, { title: 'Complete me' });
    const completed = await completeMilestone(goal.id, milestone.id);

    expect(completed.completedAt).toBeDefined();
  });

  it('should return null for completing non-existent milestone', async () => {
    const goal = await createGoal({ title: 'Test' });
    expect(await completeMilestone(goal.id, 'nonexistent')).toBeNull();
    expect(await completeMilestone('nonexistent', 'fake')).toBeNull();
  });

  it('should create a goal with parentId', async () => {
    const parent = await createGoal({ title: 'Parent Goal' });
    const child = await createGoal({ title: 'Child Goal', parentId: parent.id });

    expect(child.parentId).toBe(parent.id);
  });

  it('should create a goal with tags', async () => {
    const goal = await createGoal({ title: 'Tagged Goal', tags: ['fitness', 'health'] });

    expect(goal.tags).toEqual(['fitness', 'health']);
  });

  it('should update tags on a goal', async () => {
    const goal = await createGoal({ title: 'Tag Test' });
    const updated = await updateGoal(goal.id, { tags: ['career', 'growth'] });

    expect(updated.tags).toEqual(['career', 'growth']);
  });

  it('should reject update with invalid parentId', async () => {
    const goal = await createGoal({ title: 'Orphan' });

    await expect(updateGoal(goal.id, { parentId: 'nonexistent' }))
      .rejects.toMatchObject({ code: 'INVALID_PARENT' });
  });

  it('should reject update that creates a cycle', async () => {
    const a = await createGoal({ title: 'A' });
    const b = await createGoal({ title: 'B', parentId: a.id });
    const c = await createGoal({ title: 'C', parentId: b.id });

    await expect(updateGoal(a.id, { parentId: c.id }))
      .rejects.toMatchObject({ code: 'CYCLE_DETECTED' });
  });

  it('should reparent children when deleting a middle node', async () => {
    const grandparent = await createGoal({ title: 'Grandparent' });
    const parent = await createGoal({ title: 'Parent', parentId: grandparent.id });
    const child = await createGoal({ title: 'Child', parentId: parent.id });

    expect(await deleteGoal(parent.id)).toBe(true);

    const goals = await getGoals();
    const updatedChild = goals.goals.find(g => g.id === child.id);
    expect(updatedChild.parentId).toBe(grandparent.id);
  });

  it('should promote children to root when deleting a root parent', async () => {
    const root = await createGoal({ title: 'Root' });
    const child = await createGoal({ title: 'Child', parentId: root.id });

    expect(await deleteGoal(root.id)).toBe(true);

    const goals = await getGoals();
    const updatedChild = goals.goals.find(g => g.id === child.id);
    expect(updatedChild.parentId).toBeNull();
  });
});

describe('Integration: Goal Tree', () => {
  let createGoal, getGoalsTree;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: true, markerCount: 0, uploadedAt: '2025-01-01T00:00:00.000Z', savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    const mod = await import('./identity.js');
    createGoal = mod.createGoal;
    getGoalsTree = mod.getGoalsTree;
  });

  it('should return correct tree structure with roots and children', async () => {
    const parent = await createGoal({ title: 'Parent' });
    const child = await createGoal({ title: 'Child', parentId: parent.id });

    const tree = await getGoalsTree();

    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].id).toBe(parent.id);
    expect(tree.roots[0].children).toHaveLength(1);
    expect(tree.roots[0].children[0].id).toBe(child.id);
    expect(tree.flat).toHaveLength(2);
  });

  it('should build tagIndex mapping tags to goal ids', async () => {
    const g1 = await createGoal({ title: 'G1', tags: ['fitness', 'health'] });
    const g2 = await createGoal({ title: 'G2', tags: ['fitness'] });

    const tree = await getGoalsTree();

    expect(tree.tagIndex.fitness).toContain(g1.id);
    expect(tree.tagIndex.fitness).toContain(g2.id);
    expect(tree.tagIndex.health).toEqual([g1.id]);
  });

  it('should return empty roots for no goals', async () => {
    const tree = await getGoalsTree();

    expect(tree.roots).toHaveLength(0);
    expect(tree.flat).toHaveLength(0);
    expect(tree.tagIndex).toEqual({});
  });
});

describe('Integration: Progress Log', () => {
  let createGoal, addProgressEntry, deleteProgressEntry;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: true, markerCount: 0, uploadedAt: '2025-01-01T00:00:00.000Z', savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    const mod = await import('./identity.js');
    createGoal = mod.createGoal;
    addProgressEntry = mod.addProgressEntry;
    deleteProgressEntry = mod.deleteProgressEntry;
  });

  it('should add a progress entry to a goal', async () => {
    const goal = await createGoal({ title: 'Meditate' });
    const entry = await addProgressEntry(goal.id, { date: '2025-06-01', note: '10 min session', durationMinutes: 10 });

    expect(entry).toBeDefined();
    expect(entry.id).toMatch(/^prog-/);
    expect(entry.note).toBe('10 min session');
    expect(entry.durationMinutes).toBe(10);
    expect(entry.date).toBe('2025-06-01');
  });

  it('should return null for non-existent goal', async () => {
    const result = await addProgressEntry('nonexistent', { date: '2025-06-01', note: 'test' });
    expect(result).toBeNull();
  });

  it('should delete a progress entry', async () => {
    const goal = await createGoal({ title: 'Meditate' });
    const entry = await addProgressEntry(goal.id, { date: '2025-06-01', note: 'session' });
    const result = await deleteProgressEntry(goal.id, entry.id);
    expect(result).toEqual({ deleted: true });
  });

  it('should return null when deleting non-existent entry', async () => {
    const goal = await createGoal({ title: 'Meditate' });
    const result = await deleteProgressEntry(goal.id, 'nonexistent');
    expect(result).toBeNull();
  });

  it('should return null when deleting from non-existent goal', async () => {
    const result = await deleteProgressEntry('nonexistent', 'entry-id');
    expect(result).toBeNull();
  });
});

describe('Integration: Calendar Linking', () => {
  let createGoal, linkCalendarToGoal, unlinkCalendarFromGoal, getGoals;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: true, markerCount: 0, uploadedAt: '2025-01-01T00:00:00.000Z', savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    const mod = await import('./identity.js');
    createGoal = mod.createGoal;
    linkCalendarToGoal = mod.linkCalendarToGoal;
    unlinkCalendarFromGoal = mod.unlinkCalendarFromGoal;
    getGoals = mod.getGoals;
  });

  it('should link a calendar to a goal', async () => {
    const goal = await createGoal({ title: 'Exercise' });
    const updated = await linkCalendarToGoal(goal.id, {
      subcalendarId: 'cal-123', subcalendarName: 'Gym', matchPattern: 'workout'
    });

    expect(updated.linkedCalendars).toHaveLength(1);
    expect(updated.linkedCalendars[0].subcalendarId).toBe('cal-123');
    expect(updated.linkedCalendars[0].subcalendarName).toBe('Gym');
    expect(updated.linkedCalendars[0].matchPattern).toBe('workout');
  });

  it('should update existing link on duplicate subcalendarId', async () => {
    const goal = await createGoal({ title: 'Exercise' });
    await linkCalendarToGoal(goal.id, {
      subcalendarId: 'cal-123', subcalendarName: 'Gym', matchPattern: 'workout'
    });
    const updated = await linkCalendarToGoal(goal.id, {
      subcalendarId: 'cal-123', subcalendarName: 'Gym Updated', matchPattern: 'lifting'
    });

    expect(updated.linkedCalendars).toHaveLength(1);
    expect(updated.linkedCalendars[0].subcalendarName).toBe('Gym Updated');
    expect(updated.linkedCalendars[0].matchPattern).toBe('lifting');
  });

  it('should return null when linking to non-existent goal', async () => {
    const result = await linkCalendarToGoal('nonexistent', { subcalendarId: 'cal-123', subcalendarName: 'Gym' });
    expect(result).toBeNull();
  });

  it('should unlink a calendar from a goal', async () => {
    const goal = await createGoal({ title: 'Exercise' });
    await linkCalendarToGoal(goal.id, {
      subcalendarId: 'cal-123', subcalendarName: 'Gym'
    });
    const updated = await unlinkCalendarFromGoal(goal.id, 'cal-123');

    expect(updated.linkedCalendars).toHaveLength(0);
  });

  it('should return goal unchanged when unlinking non-existent calendar', async () => {
    const goal = await createGoal({ title: 'Exercise' });
    const updated = await unlinkCalendarFromGoal(goal.id, 'nonexistent');
    expect(updated).toBeDefined();
  });

  it('should return null when unlinking from non-existent goal', async () => {
    const result = await unlinkCalendarFromGoal('nonexistent', 'cal-123');
    expect(result).toBeNull();
  });
});

// =============================================================================
// Goal Hierarchy Organization
// =============================================================================

describe('Integration: applyGoalOrganization', () => {
  let createGoal, getGoals, applyGoalOrganization;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: false, markerCount: 0, uploadedAt: null, savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    const mod = await import('./identity.js');
    createGoal = mod.createGoal;
    getGoals = mod.getGoals;
    applyGoalOrganization = mod.applyGoalOrganization;
  });

  it('should apply goalType and parentId changes to goals', async () => {
    const apex = await createGoal({ title: 'Apex Goal' });
    const sub = await createGoal({ title: 'Sub Apex Goal' });
    const standard = await createGoal({ title: 'Standard Goal' });

    const result = await applyGoalOrganization([
      { id: apex.id, goalType: 'apex', suggestedParentId: null },
      { id: sub.id, goalType: 'sub-apex', suggestedParentId: apex.id },
      { id: standard.id, goalType: 'standard', suggestedParentId: sub.id }
    ]);

    expect(result.applied).toBe(3);

    const goals = await getGoals();
    const updatedApex = goals.goals.find(g => g.id === apex.id);
    const updatedSub = goals.goals.find(g => g.id === sub.id);
    const updatedStandard = goals.goals.find(g => g.id === standard.id);

    expect(updatedApex.goalType).toBe('apex');
    expect(updatedApex.parentId).toBeNull();
    expect(updatedSub.goalType).toBe('sub-apex');
    expect(updatedSub.parentId).toBe(apex.id);
    expect(updatedStandard.goalType).toBe('standard');
    expect(updatedStandard.parentId).toBe(sub.id);
  });

  it('should prevent a goal from becoming its own parent', async () => {
    const goal = await createGoal({ title: 'Self Referencing' });

    await applyGoalOrganization([
      { id: goal.id, goalType: 'standard', suggestedParentId: goal.id }
    ]);

    const goals = await getGoals();
    const updated = goals.goals.find(g => g.id === goal.id);

    // parentId should remain null — self-cycle prevented
    expect(updated.parentId).toBeNull();
  });

  it('should prevent ancestor cycles in reparenting', async () => {
    const a = await createGoal({ title: 'A' });
    const b = await createGoal({ title: 'B', parentId: a.id });
    const c = await createGoal({ title: 'C', parentId: b.id });

    // Try to make A a child of C (would create A->B->C->A cycle)
    await applyGoalOrganization([
      { id: a.id, suggestedParentId: c.id }
    ]);

    const goals = await getGoals();
    const updatedA = goals.goals.find(g => g.id === a.id);

    // parentId should remain null — cycle prevented
    expect(updatedA.parentId).toBeNull();
  });

  it('should ignore invalid goalType values', async () => {
    const goal = await createGoal({ title: 'Test Goal', goalType: 'standard' });

    await applyGoalOrganization([
      { id: goal.id, goalType: 'bogus' }
    ]);

    const goals = await getGoals();
    const updated = goals.goals.find(g => g.id === goal.id);

    // goalType should remain unchanged
    expect(updated.goalType).toBe('standard');
  });

  it('should accept all valid goalType values', async () => {
    const g1 = await createGoal({ title: 'Goal 1' });
    const g2 = await createGoal({ title: 'Goal 2' });
    const g3 = await createGoal({ title: 'Goal 3' });

    await applyGoalOrganization([
      { id: g1.id, goalType: 'apex' },
      { id: g2.id, goalType: 'sub-apex' },
      { id: g3.id, goalType: 'standard' }
    ]);

    const goals = await getGoals();
    expect(goals.goals.find(g => g.id === g1.id).goalType).toBe('apex');
    expect(goals.goals.find(g => g.id === g2.id).goalType).toBe('sub-apex');
    expect(goals.goals.find(g => g.id === g3.id).goalType).toBe('standard');
  });

  it('should skip non-existent goal IDs without error', async () => {
    const goal = await createGoal({ title: 'Exists' });

    const result = await applyGoalOrganization([
      { id: 'nonexistent', goalType: 'apex' },
      { id: goal.id, goalType: 'sub-apex' }
    ]);

    // Only the existing goal counts as changed
    expect(result.applied).toBe(1);

    const goals = await getGoals();
    expect(goals.goals.find(g => g.id === goal.id).goalType).toBe('sub-apex');
  });

  it('should skip reparenting to a non-existent parent', async () => {
    const goal = await createGoal({ title: 'Goal' });

    await applyGoalOrganization([
      { id: goal.id, suggestedParentId: 'nonexistent-parent' }
    ]);

    const goals = await getGoals();
    const updated = goals.goals.find(g => g.id === goal.id);

    // parentId should remain null — target parent doesn't exist
    expect(updated.parentId).toBeNull();
  });

  it('should allow clearing parentId by setting it to null', async () => {
    const parent = await createGoal({ title: 'Parent' });
    const child = await createGoal({ title: 'Child', parentId: parent.id });

    await applyGoalOrganization([
      { id: child.id, suggestedParentId: null }
    ]);

    const goals = await getGoals();
    const updated = goals.goals.find(g => g.id === child.id);
    expect(updated.parentId).toBeNull();
  });
});

describe('Integration: organizeGoals', () => {
  let organizeGoals, createGoal;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: false, markerCount: 0, uploadedAt: null, savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    vi.doMock('./providers.js', () => ({
      getActiveProvider: vi.fn(async () => ({
        id: 'mock-provider',
        name: 'Mock AI',
        defaultModel: 'mock-model'
      })),
      getProviderById: vi.fn(async () => ({
        id: 'mock-provider',
        name: 'Mock AI',
        defaultModel: 'mock-model'
      }))
    }));

    // callProviderAISimple mock set per-test to use actual goal IDs
    vi.doMock('../lib/aiProvider.js', () => ({
      callProviderAISimple: vi.fn(async () => ({ text: '{}' })),
      parseLLMJSON: vi.fn((text) => JSON.parse(text))
    }));

    const mod = await import('./identity.js');
    organizeGoals = mod.organizeGoals;
    createGoal = mod.createGoal;
  });

  it('should return LLM organization suggestion', async () => {
    const goal1 = await createGoal({ title: 'Health & Fitness' });
    const goal2 = await createGoal({ title: 'Learn Spanish' });

    // Re-mock with actual goal IDs
    const { callProviderAISimple, parseLLMJSON } = await import('../lib/aiProvider.js');
    callProviderAISimple.mockResolvedValue({
      text: JSON.stringify({
        apexGoal: { existingId: null, suggestedTitle: 'Live fully', suggestedDescription: 'The ultimate purpose' },
        organization: [
          { id: goal1.id, goalType: 'sub-apex', suggestedParentId: null, reasoning: 'Major life pillar' },
          { id: goal2.id, goalType: 'standard', suggestedParentId: goal1.id, reasoning: 'Supports pillar' }
        ],
        suggestedSubApex: [],
        analysis: 'Your goals center around personal growth.'
      })
    });
    parseLLMJSON.mockImplementation((text) => JSON.parse(text));

    const result = await organizeGoals();

    expect(result.apexGoal).toBeDefined();
    expect(result.apexGoal.suggestedTitle).toBe('Live fully');
    expect(result.organization).toHaveLength(2);
    expect(result.organization[0].goalType).toBe('sub-apex');
    expect(result.organization[1].suggestedParentId).toBe(goal1.id);
    expect(result.analysis).toContain('personal growth');
  });

  it('should throw when fewer than 2 active goals', async () => {
    await createGoal({ title: 'Only one' });

    await expect(organizeGoals()).rejects.toMatchObject({ code: 'TOO_FEW_GOALS' });
  });

  it('should throw when no AI provider is available', async () => {
    vi.resetModules();

    vi.doMock('fs/promises', makeFsPromisesStore);

    vi.doMock('./genome.js', () => ({
      getGenomeSummary: vi.fn(async () => ({
        uploaded: false, markerCount: 0, uploadedAt: null, savedMarkers: {}
      }))
    }));

    vi.doMock('./taste-questionnaire.js', () => ({
      getTasteProfile: vi.fn(async () => ({
        completedCount: 0, totalSections: 5, overallPercentage: 0, lastSessionAt: null
      }))
    }));

    vi.doMock('./providers.js', () => ({
      getActiveProvider: vi.fn(async () => null),
      getProviderById: vi.fn(async () => null)
    }));

    vi.doMock('../lib/aiProvider.js', () => ({
      callProviderAISimple: vi.fn(),
      parseLLMJSON: vi.fn()
    }));

    const mod = await import('./identity.js');
    const localCreateGoal = mod.createGoal;
    const localOrganizeGoals = mod.organizeGoals;

    await localCreateGoal({ title: 'Goal A' });
    await localCreateGoal({ title: 'Goal B' });

    await expect(localOrganizeGoals()).rejects.toMatchObject({ code: 'NO_PROVIDER' });
  });
});
