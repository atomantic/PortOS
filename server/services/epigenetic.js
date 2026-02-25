import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';

const DATA_DIR = PATHS.digitalTwin;
const EPIGENETIC_FILE = join(DATA_DIR, 'epigenetic.json');

const DEFAULT_DATA = {
  interventions: {},
  lastUpdated: null
};

/**
 * Curated neuroprotective interventions with evidence-based dosage ranges.
 * Each intervention maps to genetic markers it addresses.
 */
export const CURATED_INTERVENTIONS = [
  {
    id: 'creatine',
    name: 'Creatine Monohydrate',
    category: 'supplement',
    targetMarkers: ['cognitive_decline', 'cognitive'],
    mechanism: 'Creatine buffers ATP in the brain, supporting mitochondrial function and cellular energy. Studies show neuroprotective effects against oxidative stress and excitotoxicity. Particularly relevant for APOE ε4 carriers where mitochondrial dysfunction is an early pathological feature.',
    evidenceLevel: 'strong',
    dosageRange: { min: 3, max: 25, unit: 'g/day', optimal: '5-20g/day' },
    trackingUnit: 'g',
    references: [
      'Rae et al. (2003) - Creatine supplementation improves cognitive performance',
      'Brosnan & Brosnan (2016) - The creatine kinase system in brain energy metabolism',
      'Forbes et al. (2022) - Creatine supplementation and brain health'
    ]
  },
  {
    id: 'omega3_dha',
    name: 'Omega-3 DHA',
    category: 'supplement',
    targetMarkers: ['cognitive_decline'],
    mechanism: 'DHA is the primary structural omega-3 in the brain. It reduces neuroinflammation, supports synaptic plasticity, and promotes amyloid-beta clearance. APOE ε4 carriers show impaired brain DHA uptake, requiring higher intake.',
    evidenceLevel: 'strong',
    dosageRange: { min: 500, max: 4000, unit: 'mg/day', optimal: '1000-2000mg DHA' },
    trackingUnit: 'mg',
    references: [
      'Yassine et al. (2017) - APOE genotype modifies DHA brain uptake',
      'Cunnane et al. (2013) - Brain fuel metabolism and Alzheimer\'s',
      'Freund-Levi et al. (2006) - DHA supplementation in Alzheimer\'s disease'
    ]
  },
  {
    id: 'exercise_aerobic',
    name: 'Aerobic Exercise',
    category: 'lifestyle',
    targetMarkers: ['cognitive_decline', 'cognitive', 'cardiovascular'],
    mechanism: 'Aerobic exercise upregulates BDNF (particularly important for Val66Met carriers), promotes hippocampal neurogenesis, reduces neuroinflammation, and improves cerebrovascular function. The strongest modifiable risk factor for dementia prevention.',
    evidenceLevel: 'strong',
    dosageRange: { min: 75, max: 300, unit: 'min/week', optimal: '150-200 min/week' },
    trackingUnit: 'min',
    references: [
      'Erickson et al. (2011) - Exercise increases hippocampal volume',
      'Raichlen & Alexander (2017) - Adaptive capacity model of cognitive aging',
      'Livingston et al. (2020) - Lancet Commission on dementia prevention'
    ]
  },
  {
    id: 'sleep_quality',
    name: 'Sleep Optimization',
    category: 'lifestyle',
    targetMarkers: ['cognitive_decline', 'sleep'],
    mechanism: 'During deep sleep, the glymphatic system clears amyloid-beta and tau from the brain. Poor sleep quality accelerates amyloid accumulation. 7-9 hours with adequate slow-wave sleep is critical for brain waste clearance.',
    evidenceLevel: 'strong',
    dosageRange: { min: 7, max: 9, unit: 'hours/night', optimal: '7.5-8.5 hours' },
    trackingUnit: 'hours',
    references: [
      'Xie et al. (2013) - Glymphatic system and sleep-driven brain waste clearance',
      'Shokri-Kojori et al. (2018) - Sleep deprivation increases amyloid-beta accumulation',
      'Winer et al. (2020) - Sleep disturbance and Alzheimer\'s pathology'
    ]
  },
  {
    id: 'vitamin_d',
    name: 'Vitamin D',
    category: 'supplement',
    targetMarkers: ['cognitive_decline', 'nutrient'],
    mechanism: 'Vitamin D receptors are expressed throughout the brain. Deficiency is associated with accelerated cognitive decline and increased dementia risk. VDR and VDBP gene variants affect required supplementation levels.',
    evidenceLevel: 'moderate',
    dosageRange: { min: 1000, max: 5000, unit: 'IU/day', optimal: '2000-4000 IU/day' },
    trackingUnit: 'IU',
    references: [
      'Littlejohns et al. (2014) - Vitamin D and risk of dementia and Alzheimer\'s',
      'Balion et al. (2012) - Vitamin D cognition and dementia meta-analysis'
    ]
  },
  {
    id: 'meditation',
    name: 'Meditation / Mindfulness',
    category: 'lifestyle',
    targetMarkers: ['cognitive_decline', 'cognitive', 'inflammation'],
    mechanism: 'Regular meditation reduces cortisol, lowers neuroinflammation, and preserves gray matter volume. Long-term meditators show less age-related cortical thinning and better preserved hippocampal volume.',
    evidenceLevel: 'moderate',
    dosageRange: { min: 10, max: 60, unit: 'min/day', optimal: '20-30 min/day' },
    trackingUnit: 'min',
    references: [
      'Luders et al. (2015) - Meditation and brain aging',
      'Creswell et al. (2016) - Mindfulness and inflammatory biomarkers'
    ]
  },
  {
    id: 'b_vitamins',
    name: 'B-Vitamin Complex (B6/B9/B12)',
    category: 'supplement',
    targetMarkers: ['cognitive_decline', 'methylation'],
    mechanism: 'B vitamins lower homocysteine, a neurotoxin linked to brain atrophy and dementia. Particularly critical for MTHFR variant carriers who have impaired folate metabolism. Use methylfolate (not folic acid) for MTHFR C677T carriers.',
    evidenceLevel: 'strong',
    dosageRange: { min: 1, max: 1, unit: 'complex/day', optimal: 'Methylated B-complex daily' },
    trackingUnit: 'dose',
    references: [
      'Smith et al. (2010) - B vitamins slow brain atrophy in MCI',
      'Douaud et al. (2013) - B vitamins reduce brain atrophy in Alzheimer\'s-vulnerable regions'
    ]
  },
  {
    id: 'curcumin',
    name: 'Curcumin (Turmeric Extract)',
    category: 'supplement',
    targetMarkers: ['cognitive_decline', 'inflammation'],
    mechanism: 'Curcumin crosses the blood-brain barrier and reduces neuroinflammation, inhibits amyloid-beta aggregation, and chelates iron. Bioavailability is critical — use piperine-enhanced or liposomal forms.',
    evidenceLevel: 'moderate',
    dosageRange: { min: 500, max: 2000, unit: 'mg/day', optimal: '1000mg bioavailable form' },
    trackingUnit: 'mg',
    references: [
      'Small et al. (2018) - Memory and brain amyloid effects of curcumin',
      'Voulgaropoulou et al. (2019) - Curcumin and cognition meta-analysis'
    ]
  },
  {
    id: 'cognitive_training',
    name: 'Cognitive Stimulation',
    category: 'lifestyle',
    targetMarkers: ['cognitive_decline', 'cognitive'],
    mechanism: 'Novel cognitive challenges build cognitive reserve — the brain\'s resilience against neurodegeneration. Activities like learning new languages, musical instruments, or complex problem-solving strengthen synaptic networks.',
    evidenceLevel: 'moderate',
    dosageRange: { min: 15, max: 60, unit: 'min/day', optimal: '30+ min/day of novel challenges' },
    trackingUnit: 'min',
    references: [
      'Stern (2012) - Cognitive reserve in ageing and Alzheimer\'s disease',
      'Wilson et al. (2013) - Life-span cognitive activity and late-life cognitive decline'
    ]
  },
  {
    id: 'social_engagement',
    name: 'Social Engagement',
    category: 'lifestyle',
    targetMarkers: ['cognitive_decline'],
    mechanism: 'Social isolation is a major modifiable dementia risk factor. Regular social interaction stimulates diverse cognitive processes and reduces cortisol-driven neuroinflammation. Effect size comparable to physical exercise.',
    evidenceLevel: 'strong',
    dosageRange: { min: 3, max: 7, unit: 'interactions/week', optimal: 'Daily meaningful interaction' },
    trackingUnit: 'interactions',
    references: [
      'Livingston et al. (2020) - Lancet Commission: social isolation as dementia risk factor',
      'Kuiper et al. (2015) - Social relationships and dementia risk meta-analysis'
    ]
  },
  {
    id: 'magnesium_threonate',
    name: 'Magnesium L-Threonate',
    category: 'supplement',
    targetMarkers: ['cognitive_decline', 'cognitive', 'sleep'],
    mechanism: 'Magnesium threonate is the only magnesium form shown to significantly increase brain magnesium levels. It enhances synaptic density, supports NMDA receptor function, and improves both short-term and long-term memory.',
    evidenceLevel: 'moderate',
    dosageRange: { min: 1000, max: 2000, unit: 'mg/day', optimal: '1500-2000mg before bed' },
    trackingUnit: 'mg',
    references: [
      'Slutsky et al. (2010) - Enhancement of learning and memory by elevating brain magnesium',
      'Liu et al. (2016) - Magnesium-L-threonate and cognitive abilities'
    ]
  },
  {
    id: 'lions_mane',
    name: 'Lion\'s Mane Mushroom',
    category: 'supplement',
    targetMarkers: ['cognitive_decline', 'cognitive'],
    mechanism: 'Lion\'s mane contains hericenones and erinacines that stimulate nerve growth factor (NGF) synthesis. NGF is critical for neuronal survival and synaptic plasticity. Particularly relevant for BDNF Met carriers with reduced neurotrophin signaling.',
    evidenceLevel: 'emerging',
    dosageRange: { min: 500, max: 3000, unit: 'mg/day', optimal: '1000-2000mg of fruiting body extract' },
    trackingUnit: 'mg',
    references: [
      'Mori et al. (2009) - Lion\'s mane improves mild cognitive impairment',
      'Li et al. (2018) - Neurohealth properties of Hericium erinaceus'
    ]
  }
];

async function loadData() {
  await ensureDir(DATA_DIR);
  const raw = await readFile(EPIGENETIC_FILE, 'utf-8').catch(() => null);
  if (!raw) return { ...DEFAULT_DATA };
  return safeJSONParse(raw, { ...DEFAULT_DATA });
}

async function saveData(data) {
  await ensureDir(DATA_DIR);
  data.lastUpdated = new Date().toISOString();
  await writeFile(EPIGENETIC_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get all tracked interventions with their logs.
 */
export async function getInterventions() {
  const data = await loadData();
  return {
    interventions: data.interventions,
    lastUpdated: data.lastUpdated,
    curatedCount: CURATED_INTERVENTIONS.length,
    trackedCount: Object.keys(data.interventions).length
  };
}

/**
 * Get curated intervention recommendations, optionally filtered by genetic markers present.
 */
export function getRecommendations(markerCategories = []) {
  if (markerCategories.length === 0) return CURATED_INTERVENTIONS;
  return CURATED_INTERVENTIONS.filter(i =>
    i.targetMarkers.some(t => markerCategories.includes(t))
  );
}

/**
 * Start tracking an intervention (curated or custom).
 */
export async function addIntervention(intervention) {
  const data = await loadData();
  const id = intervention.id || randomUUID();

  // Check if it's a curated one
  const curated = CURATED_INTERVENTIONS.find(c => c.id === id);

  data.interventions[id] = {
    id,
    name: intervention.name || curated?.name || 'Unknown',
    category: intervention.category || curated?.category || 'custom',
    dosage: intervention.dosage || '',
    frequency: intervention.frequency || 'daily',
    trackingUnit: intervention.trackingUnit || curated?.trackingUnit || 'dose',
    startedAt: new Date().toISOString(),
    active: true,
    notes: intervention.notes || '',
    logs: []
  };

  await saveData(data);
  console.log(`🧬 Epigenetic intervention tracked: ${data.interventions[id].name}`);
  return data.interventions[id];
}

/**
 * Log a daily entry for a tracked intervention.
 */
export async function logEntry(interventionId, entry) {
  const data = await loadData();
  const intervention = data.interventions[interventionId];
  if (!intervention) return { error: 'Intervention not found' };

  const log = {
    id: randomUUID(),
    date: entry.date || new Date().toISOString().split('T')[0],
    amount: entry.amount,
    unit: intervention.trackingUnit,
    notes: entry.notes || '',
    loggedAt: new Date().toISOString()
  };

  // Avoid duplicate date entries — update existing
  const existingIdx = intervention.logs.findIndex(l => l.date === log.date);
  if (existingIdx >= 0) {
    intervention.logs[existingIdx] = { ...intervention.logs[existingIdx], ...log };
  } else {
    intervention.logs.push(log);
  }

  // Keep logs sorted by date
  intervention.logs.sort((a, b) => a.date.localeCompare(b.date));

  await saveData(data);
  console.log(`🧬 Logged ${log.amount} ${log.unit} of ${intervention.name} for ${log.date}`);
  return log;
}

/**
 * Update an intervention's settings.
 */
export async function updateIntervention(interventionId, updates) {
  const data = await loadData();
  const intervention = data.interventions[interventionId];
  if (!intervention) return { error: 'Intervention not found' };

  if (updates.dosage !== undefined) intervention.dosage = updates.dosage;
  if (updates.frequency !== undefined) intervention.frequency = updates.frequency;
  if (updates.notes !== undefined) intervention.notes = updates.notes;
  if (updates.active !== undefined) intervention.active = updates.active;
  if (updates.name !== undefined) intervention.name = updates.name;

  await saveData(data);
  console.log(`🧬 Updated intervention: ${intervention.name}`);
  return intervention;
}

/**
 * Delete an intervention and its logs.
 */
export async function deleteIntervention(interventionId) {
  const data = await loadData();
  if (!data.interventions[interventionId]) return { error: 'Intervention not found' };

  const name = data.interventions[interventionId].name;
  delete data.interventions[interventionId];
  await saveData(data);
  console.log(`🧬 Deleted intervention: ${name}`);
  return { success: true };
}

/**
 * Get compliance summary for tracked interventions over the last N days.
 */
export async function getComplianceSummary(days = 30) {
  const data = await loadData();
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days);
  const startStr = startDate.toISOString().split('T')[0];

  const summary = {};
  for (const [id, intervention] of Object.entries(data.interventions)) {
    if (!intervention.active) continue;

    const recentLogs = intervention.logs.filter(l => l.date >= startStr);
    const daysCovered = new Set(recentLogs.map(l => l.date)).size;
    const expectedDays = intervention.frequency === 'daily' ? days
      : intervention.frequency === 'weekly' ? Math.ceil(days / 7)
      : days;

    summary[id] = {
      name: intervention.name,
      category: intervention.category,
      compliance: expectedDays > 0 ? Math.min(1, daysCovered / expectedDays) : 0,
      daysCovered,
      expectedDays,
      recentLogCount: recentLogs.length,
      lastLogged: recentLogs.length > 0 ? recentLogs[recentLogs.length - 1].date : null,
      streak: calculateStreak(intervention.logs)
    };
  }

  return { summary, periodDays: days, startDate: startStr };
}

/**
 * Calculate the current consecutive-day streak for an intervention.
 */
function calculateStreak(logs) {
  if (logs.length === 0) return 0;

  const today = new Date().toISOString().split('T')[0];
  const dates = new Set(logs.map(l => l.date));

  // Check if today or yesterday has an entry (grace period)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  if (!dates.has(today) && !dates.has(yesterdayStr)) return 0;

  let streak = 0;
  const startDate = dates.has(today) ? new Date() : yesterday;

  for (let d = new Date(startDate); ; d.setDate(d.getDate() - 1)) {
    const dateStr = d.toISOString().split('T')[0];
    if (dates.has(dateStr)) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}
