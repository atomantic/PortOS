import { getGenomeSummary } from '../genome.js';
import { CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE, loadJSON, saveJSON } from './store.js';
import { MARKER_WEIGHTS, extractSleepMarkers, extractCaffeineMarkers } from './markers.js';

const SCHEDULE_TEMPLATES = {
  morning: {
    wakeTime: '06:00',
    sleepTime: '22:00',
    peakFocusStart: '08:00',
    peakFocusEnd: '12:00',
    exerciseWindow: '06:30-08:00',
    windDownStart: '20:30'
  },
  intermediate: {
    wakeTime: '07:00',
    sleepTime: '23:00',
    peakFocusStart: '09:30',
    peakFocusEnd: '13:00',
    exerciseWindow: '07:30-09:00',
    windDownStart: '21:30'
  },
  evening: {
    wakeTime: '08:30',
    sleepTime: '00:30',
    peakFocusStart: '11:00',
    peakFocusEnd: '15:00',
    exerciseWindow: '10:00-12:00',
    windDownStart: '23:00'
  }
};

// === Pure Functions (exported for testing) ===

export function computeChronotype(geneticMarkers, behavioralData) {
  const markerNames = Object.keys(geneticMarkers);
  const hasGenetic = markerNames.length > 0;
  const hasBehavioral = behavioralData?.preferredWakeTime || behavioralData?.preferredSleepTime;

  // Genetic score: weighted average of directional signals
  let geneticScore = 0;
  let totalWeight = 0;
  for (const name of markerNames) {
    const weight = MARKER_WEIGHTS[name] ?? 0;
    geneticScore += geneticMarkers[name].signal * weight;
    totalWeight += weight;
  }
  if (totalWeight > 0) {
    geneticScore /= totalWeight;
  }

  // Behavioral score from wake/sleep times
  let behavioralScore = 0;
  if (hasBehavioral) {
    const scores = [];
    if (behavioralData.preferredWakeTime) {
      const [h] = behavioralData.preferredWakeTime.split(':').map(Number);
      // Before 7 = morning (-1), after 9 = evening (+1), between = interpolate
      scores.push(Math.max(-1, Math.min(1, (h - 8) / 2)));
    }
    if (behavioralData.preferredSleepTime) {
      const [h] = behavioralData.preferredSleepTime.split(':').map(Number);
      // Normalize: hours after midnight (0-5) count as 24-29
      const normalizedH = h < 6 ? h + 24 : h;
      // Before 22 = morning (-1), after midnight (24) = evening (+1)
      scores.push(Math.max(-1, Math.min(1, (normalizedH - 23) / 2)));
    }
    if (scores.length > 0) {
      behavioralScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }

  // Composite score
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

  // Classification
  let type;
  if (composite < -0.25) {
    type = 'morning';
  } else if (composite > 0.25) {
    type = 'evening';
  } else {
    type = 'intermediate';
  }

  // Confidence calculation
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

export function computeRecommendations(type, caffeineMarkers, mtnr1bStatus) {
  const schedule = { ...SCHEDULE_TEMPLATES[type] };

  // Caffeine cutoff based on CYP1A2 metabolism
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

  // Late-eating cutoff based on MTNR1B
  if (mtnr1bStatus === 'concern' || mtnr1bStatus === 'major_concern') {
    schedule.lastMealCutoff = '19:00';
    schedule.mealNote = 'MTNR1B variant — earlier meals may improve glucose response';
  } else {
    schedule.lastMealCutoff = '20:30';
    schedule.mealNote = 'Standard meal timing recommendation';
  }

  return schedule;
}

// === Service Functions ===

export async function getChronotype() {
  const existing = await loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE);
  if (existing.derivedAt) return existing;
  return deriveChronotype();
}

export async function deriveChronotype() {
  const genomeSummary = await getGenomeSummary();
  const savedMarkers = genomeSummary?.savedMarkers || {};

  const geneticMarkers = extractSleepMarkers(savedMarkers);
  const caffeineMarkers = extractCaffeineMarkers(savedMarkers);

  // Load existing behavioral data if present
  const existing = await loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE);
  const behavioralData = existing.behavioralData;

  const { type, confidence, scores } = computeChronotype(geneticMarkers, behavioralData);

  const mtnr1bStatus = geneticMarkers.mtnr1b?.status ?? null;
  const recommendations = computeRecommendations(type, caffeineMarkers, mtnr1bStatus);

  const chronotype = {
    type,
    confidence,
    scores,
    geneticMarkers,
    caffeineMarkers,
    behavioralData,
    recommendations,
    derivedAt: new Date().toISOString()
  };

  await saveJSON(CHRONOTYPE_FILE, chronotype);
  console.log(`🧬 Chronotype derived: ${type} (confidence: ${confidence})`);

  return chronotype;
}

export async function updateChronotypeBehavioral(overrides) {
  const existing = await loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE);
  const behavioralData = { ...(existing.behavioralData || {}), ...overrides };

  // Save behavioral data then re-derive
  existing.behavioralData = behavioralData;
  await saveJSON(CHRONOTYPE_FILE, existing);

  return deriveChronotype();
}

/**
 * Get structured energy zones for the day based on chronotype.
 * Returns time blocks with zone type, start/end times, and display metadata.
 */
export async function getEnergySchedule() {
  const chronotype = await getChronotype();
  if (!chronotype?.recommendations) return { zones: [], type: null, confidence: 0 };

  const rec = chronotype.recommendations;

  const parseTime = (str) => {
    const [h, m] = (str || '').split(':').map(Number);
    const mins = h * 60 + (m || 0);
    return Number.isFinite(mins) && mins >= 0 && mins <= 1440 ? mins : NaN;
  };

  const validMinutes = (...vals) => vals.every(v => Number.isFinite(v));

  const zones = [];

  // Wake-up zone
  if (rec.wakeTime) {
    const wake = parseTime(rec.wakeTime);
    if (validMinutes(wake)) {
      zones.push({ id: 'wake', label: 'Wake Up', startMin: wake, endMin: wake + 30, color: '#f59e0b', opacity: 0.12 });
    }
  }

  // Exercise window (e.g., "06:30-08:00")
  if (rec.exerciseWindow) {
    const [exStart, exEnd] = rec.exerciseWindow.split('-').map(parseTime);
    if (validMinutes(exStart, exEnd) && exEnd >= exStart) {
      zones.push({ id: 'exercise', label: 'Exercise', startMin: exStart, endMin: exEnd, color: '#22c55e', opacity: 0.10 });
    }
  }

  // Peak focus
  if (rec.peakFocusStart && rec.peakFocusEnd) {
    const start = parseTime(rec.peakFocusStart);
    const end = parseTime(rec.peakFocusEnd);
    if (validMinutes(start, end) && end >= start) {
      zones.push({
        id: 'peak-focus',
        label: 'Peak Focus',
        startMin: start,
        endMin: end,
        color: '#3b82f6',
        opacity: 0.12
      });
    }
  }

  // Caffeine cutoff (marker, not a zone)
  if (rec.caffeineCutoff) {
    const cutoff = parseTime(rec.caffeineCutoff);
    if (validMinutes(cutoff)) {
      zones.push({ id: 'caffeine-cutoff', label: 'Caffeine Cutoff', startMin: cutoff, endMin: cutoff, color: '#ef4444', opacity: 0, marker: true });
    }
  }

  // Last meal cutoff
  if (rec.lastMealCutoff) {
    const meal = parseTime(rec.lastMealCutoff);
    if (validMinutes(meal)) {
      zones.push({ id: 'meal-cutoff', label: 'Last Meal', startMin: meal, endMin: meal, color: '#f97316', opacity: 0, marker: true });
    }
  }

  // Wind-down
  if (rec.windDownStart && rec.sleepTime) {
    const windStart = parseTime(rec.windDownStart);
    const windEnd = parseTime(rec.sleepTime);
    if (validMinutes(windStart, windEnd) && windEnd >= windStart) {
      zones.push({
        id: 'wind-down',
        label: 'Wind Down',
        startMin: windStart,
        endMin: windEnd,
        color: '#8b5cf6',
        opacity: 0.10
      });
    }
  }

  return {
    zones,
    type: chronotype.type,
    confidence: chronotype.confidence,
    wakeTime: rec.wakeTime,
    sleepTime: rec.sleepTime
  };
}
