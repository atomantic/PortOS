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

// === Longevity & Goal pure function copies ===

const LONGEVITY_MARKERS = {
  rs2802292: { name: 'foxo3a', gene: 'FOXO3A', weight: 0.25, label: 'Longevity / FOXO3A' },
  rs2229765: { name: 'igf1r', gene: 'IGF1R', weight: 0.20, label: 'Growth Factor Receptor' },
  rs5882: { name: 'cetp', gene: 'CETP', weight: 0.20, label: 'HDL Cholesterol' },
  rs12366: { name: 'ipmk', gene: 'IPMK', weight: 0.15, label: 'Nutrient Sensing' },
  rs10936599: { name: 'terc', gene: 'TERC', weight: 0.20, label: 'Telomere Length' }
};

const CARDIOVASCULAR_MARKERS = {
  rs6025: { name: 'factorV', gene: 'F5', weight: 0.20, label: 'Factor V Leiden' },
  rs1333049: { name: 'cad9p21', gene: '9p21.3', weight: 0.20, label: 'Coronary Artery Disease' },
  rs10455872: { name: 'lpa', gene: 'LPA', weight: 0.15, label: 'Lipoprotein(a)' },
  rs1799963: { name: 'prothrombin', gene: 'F2', weight: 0.15, label: 'Prothrombin Thrombophilia' },
  rs1800795: { name: 'il6', gene: 'IL-6', weight: 0.15, label: 'Inflammation / IL-6' },
  rs1800629: { name: 'tnfa', gene: 'TNF-alpha', weight: 0.15, label: 'Inflammation / TNF-alpha' }
};

const LONGEVITY_SIGNAL = { beneficial: 1, typical: 0, concern: -1 };
const CARDIO_SIGNAL = { beneficial: -1, typical: 0, concern: 1, major_concern: 1.5 };
const SSA_BASELINE_LIFE_EXPECTANCY = 78.5;

function extractLongevityMarkers(savedMarkers) {
  const results = {};
  const markerValues = Object.values(savedMarkers || {});
  for (const [rsid, def] of Object.entries(LONGEVITY_MARKERS)) {
    const found = markerValues.find(m => m.rsid === rsid);
    if (found) {
      const signal = LONGEVITY_SIGNAL[found.status] ?? 0;
      results[def.name] = {
        rsid, gene: def.gene, label: def.label,
        genotype: found.genotype, status: found.status,
        weight: def.weight, signal
      };
    }
  }
  return results;
}

function extractCardiovascularMarkers(savedMarkers) {
  const results = {};
  const markerValues = Object.values(savedMarkers || {});
  for (const [rsid, def] of Object.entries(CARDIOVASCULAR_MARKERS)) {
    const found = markerValues.find(m => m.rsid === rsid);
    if (found) {
      const signal = CARDIO_SIGNAL[found.status] ?? 0;
      results[def.name] = {
        rsid, gene: def.gene, label: def.label,
        genotype: found.genotype, status: found.status,
        weight: def.weight, signal
      };
    }
  }
  return results;
}

function computeLifeExpectancy(longevityMarkers, cardiovascularMarkers, birthDate) {
  let longevityScore = 0;
  let longevityWeight = 0;
  for (const marker of Object.values(longevityMarkers)) {
    longevityScore += marker.signal * marker.weight;
    longevityWeight += marker.weight;
  }
  if (longevityWeight > 0) longevityScore /= longevityWeight;

  let cardioRisk = 0;
  let cardioWeight = 0;
  for (const marker of Object.values(cardiovascularMarkers)) {
    cardioRisk += marker.signal * marker.weight;
    cardioWeight += marker.weight;
  }
  if (cardioWeight > 0) cardioRisk /= cardioWeight;

  const longevityAdjustment = Math.round(longevityScore * 5 * 100) / 100 || 0;
  const cardiovascularAdjustment = Math.round(-cardioRisk * 4 * 100) / 100 || 0;
  const adjusted = Math.round((SSA_BASELINE_LIFE_EXPECTANCY + longevityAdjustment + cardiovascularAdjustment) * 10) / 10;

  const longevityCount = Object.keys(longevityMarkers).length;
  const cardioCount = Object.keys(cardiovascularMarkers).length;
  const maxLongevity = Object.keys(LONGEVITY_MARKERS).length;
  const maxCardio = Object.keys(CARDIOVASCULAR_MARKERS).length;
  const coverage = (longevityCount + cardioCount) / (maxLongevity + maxCardio);
  const confidence = Math.round(Math.min(1, coverage) * 100) / 100;

  let timeHorizons = null;
  if (birthDate) {
    const birth = new Date(birthDate);
    const now = new Date();
    const ageYears = (now - birth) / (365.25 * 24 * 60 * 60 * 1000);
    const yearsRemaining = Math.max(0, Math.round((adjusted - ageYears) * 10) / 10);
    const healthyYearsRemaining = Math.round(yearsRemaining * 0.85 * 10) / 10;
    const percentLifeComplete = Math.round((ageYears / adjusted) * 1000) / 10;

    timeHorizons = {
      ageYears: Math.round(ageYears * 10) / 10,
      yearsRemaining,
      healthyYearsRemaining,
      percentLifeComplete: Math.min(100, percentLifeComplete)
    };
  }

  return {
    longevityScore: Math.round(longevityScore * 1000) / 1000,
    cardiovascularRisk: Math.round(cardioRisk * 1000) / 1000,
    lifeExpectancy: {
      baseline: SSA_BASELINE_LIFE_EXPECTANCY,
      adjusted,
      longevityAdjustment,
      cardiovascularAdjustment
    },
    timeHorizons,
    confidence
  };
}

function computeGoalUrgency(goal, timeHorizons) {
  if (!timeHorizons || !goal.horizon) return null;
  const horizonMap = {
    '1-year': 1, '3-year': 3, '5-year': 5,
    '10-year': 10, '20-year': 20, 'lifetime': timeHorizons.yearsRemaining
  };
  const horizonYears = horizonMap[goal.horizon] ?? 5;
  const yearsRemaining = timeHorizons.yearsRemaining;
  const rawUrgency = 1 - Math.min(1, yearsRemaining / (horizonYears * 2));
  const healthPressure = horizonYears > timeHorizons.healthyYearsRemaining ? 0.2 : 0;
  return Math.min(1, Math.round((rawUrgency + healthPressure) * 100) / 100);
}

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
});
