import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Pure function copies for unit testing (avoids complex mocking) ===

const SLEEP_MARKERS = {
  rs1801260: 'clockGene',
  rs57875989: 'dec2',
  rs35333999: 'per2',
  rs2287161: 'cry1',
  rs4753426: 'mtnr1b'
};

const CAFFEINE_MARKERS = {
  rs762551: 'cyp1a2',
  rs73598374: 'ada'
};

const MARKER_WEIGHTS = {
  cry1: 0.30,
  clockGene: 0.25,
  per2: 0.20,
  mtnr1b: 0.15,
  dec2: 0.10
};

const SIGNAL_MAP = {
  clockGene: { beneficial: -1, typical: 0, concern: 1 },
  dec2: { beneficial: -1, typical: 0, concern: 1 },
  per2: { beneficial: -1, typical: 0, concern: 1 },
  cry1: { beneficial: 1, typical: 0, concern: -1 },
  mtnr1b: { beneficial: 0, typical: 0, concern: 1 }
};

const SCHEDULE_TEMPLATES = {
  morning: {
    wakeTime: '06:00', sleepTime: '22:00',
    peakFocusStart: '08:00', peakFocusEnd: '12:00',
    exerciseWindow: '06:30-08:00', windDownStart: '20:30'
  },
  intermediate: {
    wakeTime: '07:00', sleepTime: '23:00',
    peakFocusStart: '09:30', peakFocusEnd: '13:00',
    exerciseWindow: '07:30-09:00', windDownStart: '21:30'
  },
  evening: {
    wakeTime: '08:30', sleepTime: '00:30',
    peakFocusStart: '11:00', peakFocusEnd: '15:00',
    exerciseWindow: '10:00-12:00', windDownStart: '23:00'
  }
};

function extractSleepMarkers(savedMarkers) {
  const results = {};
  const markerValues = Object.values(savedMarkers || {});
  for (const [rsid, name] of Object.entries(SLEEP_MARKERS)) {
    const found = markerValues.find(m => m.rsid === rsid);
    if (found) {
      const signalMap = SIGNAL_MAP[name];
      const signal = signalMap?.[found.status] ?? 0;
      results[name] = { rsid, genotype: found.genotype, status: found.status, signal };
    }
  }
  return results;
}

function extractCaffeineMarkers(savedMarkers) {
  const results = {};
  const markerValues = Object.values(savedMarkers || {});
  for (const [rsid, name] of Object.entries(CAFFEINE_MARKERS)) {
    const found = markerValues.find(m => m.rsid === rsid);
    if (found) {
      results[name] = { rsid, genotype: found.genotype, status: found.status };
    }
  }
  return results;
}

function computeChronotype(geneticMarkers, behavioralData) {
  const markerNames = Object.keys(geneticMarkers);
  const hasGenetic = markerNames.length > 0;
  const hasBehavioral = behavioralData?.preferredWakeTime || behavioralData?.preferredSleepTime;

  let geneticScore = 0;
  let totalWeight = 0;
  for (const name of markerNames) {
    const weight = MARKER_WEIGHTS[name] ?? 0;
    geneticScore += geneticMarkers[name].signal * weight;
    totalWeight += weight;
  }
  if (totalWeight > 0) geneticScore /= totalWeight;

  let behavioralScore = 0;
  if (hasBehavioral) {
    const scores = [];
    if (behavioralData.preferredWakeTime) {
      const [h] = behavioralData.preferredWakeTime.split(':').map(Number);
      scores.push(Math.max(-1, Math.min(1, (h - 8) / 2)));
    }
    if (behavioralData.preferredSleepTime) {
      const [h] = behavioralData.preferredSleepTime.split(':').map(Number);
      const normalizedH = h < 6 ? h + 24 : h;
      scores.push(Math.max(-1, Math.min(1, (normalizedH - 23) / 2)));
    }
    if (scores.length > 0) {
      behavioralScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }

  let composite;
  if (hasGenetic && hasBehavioral) {
    composite = (geneticScore + behavioralScore) / 2;
  } else if (hasGenetic) {
    composite = geneticScore;
  } else if (hasBehavioral) {
    composite = behavioralScore;
  } else {
    composite = 0;
  }

  let type;
  if (composite < -0.25) type = 'morning';
  else if (composite > 0.25) type = 'evening';
  else type = 'intermediate';

  const markerCount = markerNames.length;
  const maxMarkers = Object.keys(MARKER_WEIGHTS).length;
  const markerConfidence = Math.min(0.5, (markerCount / maxMarkers) * 0.5);
  const behavioralConfidence = hasBehavioral ? 0.3 : 0;

  let agreementBonus = 0;
  if (hasGenetic && hasBehavioral) {
    const sameDirection = Math.sign(geneticScore) === Math.sign(behavioralScore) &&
      Math.sign(geneticScore) !== 0;
    agreementBonus = sameDirection ? 0.2 : -0.1;
  }

  const confidence = Math.max(0, Math.min(1,
    markerConfidence + behavioralConfidence + agreementBonus
  ));

  return {
    type,
    confidence: Math.round(confidence * 100) / 100,
    scores: {
      genetic: Math.round(geneticScore * 1000) / 1000,
      behavioral: Math.round(behavioralScore * 1000) / 1000,
      composite: Math.round(composite * 1000) / 1000
    }
  };
}

function computeRecommendations(type, caffeineMarkers, mtnr1bStatus) {
  const schedule = { ...SCHEDULE_TEMPLATES[type] };

  const cyp1a2 = caffeineMarkers?.cyp1a2;
  if (cyp1a2?.status === 'beneficial') {
    schedule.caffeineCutoff = '16:00';
    schedule.caffeineNote = 'Fast metabolizer — caffeine clears quickly';
  } else if (cyp1a2?.status === 'concern' || cyp1a2?.status === 'major_concern') {
    schedule.caffeineCutoff = '12:00';
    schedule.caffeineNote = 'Slow metabolizer — limit afternoon caffeine';
  } else {
    schedule.caffeineCutoff = '14:00';
    schedule.caffeineNote = 'Typical metabolism — moderate afternoon cutoff';
  }

  if (mtnr1bStatus === 'concern' || mtnr1bStatus === 'major_concern') {
    schedule.lastMealCutoff = '19:00';
    schedule.mealNote = 'MTNR1B variant — earlier meals may improve glucose response';
  } else {
    schedule.lastMealCutoff = '20:30';
    schedule.mealNote = 'Standard meal timing recommendation';
  }

  return schedule;
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

// === Integration tests (mock fs + genome service) ===

describe('Integration: deriveChronotype', () => {
  let deriveChronotype, getChronotype, updateChronotypeBehavioral, getIdentityStatus;

  beforeEach(async () => {
    vi.resetModules();

    // Mock fs/promises
    vi.doMock('fs/promises', () => {
      const store = {};
      return {
        readFile: vi.fn(async (path) => {
          if (store[path]) return store[path];
          throw new Error('ENOENT');
        }),
        writeFile: vi.fn(async (path, data) => {
          store[path] = data;
        }),
        mkdir: vi.fn(async () => {})
      };
    });

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

    vi.doMock('fs/promises', () => {
      const store = {};
      return {
        readFile: vi.fn(async (path) => {
          if (store[path]) return store[path];
          throw new Error('ENOENT');
        }),
        writeFile: vi.fn(async (path, data) => {
          store[path] = data;
        }),
        mkdir: vi.fn(async () => {})
      };
    });

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

  it('should return all four sections', async () => {
    const result = await getIdentityStatus();

    expect(result.sections.genome).toBeDefined();
    expect(result.sections.chronotype).toBeDefined();
    expect(result.sections.aesthetics).toBeDefined();
    expect(result.sections.goals).toBeDefined();
  });

  it('should show genome as active when markers exist', async () => {
    vi.resetModules();

    vi.doMock('fs/promises', () => {
      const store = {};
      return {
        readFile: vi.fn(async (path) => {
          if (store[path]) return store[path];
          throw new Error('ENOENT');
        }),
        writeFile: vi.fn(async (path, data) => { store[path] = data; }),
        mkdir: vi.fn(async () => {})
      };
    });

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
});
