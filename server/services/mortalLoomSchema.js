/** Persisted MortalLoom wire shapes; validate without dropping unknown fields. */
import { z } from 'zod';
import { storeFailure } from './mortalLoomCommit.js';

export const NATIVE_HORIZONS = ['1-year', '3-year', '5-year', '10-year', '20-year', 'lifetime'];
export const NATIVE_CATEGORIES = ['health', 'creative', 'family', 'financial', 'legacy', 'mastery'];
export const NATIVE_GOAL_TYPES = ['apex', 'subApex', 'standard'];
export const NATIVE_GOAL_STATUSES = ['active', 'paused', 'completed', 'abandoned'];
const number = z.number().finite();
const integer = z.number().int();
const string = z.string();
const uuid = z.string().regex(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
const object = shape => z.object(shape).passthrough();
const entry = { id: uuid, date: string };
const strings = z.array(string);
const nullable = schema => schema.nullish();
const optionalEnum = choices => nullable(z.enum(choices));
const geneticEvidence = object({ rsid: string, gene: string, reason: string, actionId: string });

const profile = object({
  birthDate: nullable(string), biologicalSex: nullable(z.enum(['male', 'female'])),
  countdownMode: nullable(z.enum(['Standard', 'LEV'])), levTargetAge: nullable(number),
  lifestyle: object({
    smokingStatus: z.enum(['never', 'former', 'current']), dietQuality: z.enum(['excellent', 'good', 'fair', 'poor']),
    stressLevel: z.enum(['low', 'moderate', 'high']), exerciseMinutesPerWeek: integer,
    sleepHoursPerNight: number, bmi: nullable(number),
  }),
  locationProfile: nullable(object({ countryCode: nullable(string), regionCode: nullable(string), airQuality: optionalEnum(['Good', 'Moderate', 'Unhealthy', 'Hazardous']), useAutoDetect: nullable(z.boolean()) })),
  socioeconomic: nullable(object({
    education: nullable(z.enum(['No HS', 'High School', 'Some College', "Bachelor's", 'Graduate'])),
    incomeBracket: nullable(z.enum(['Bottom 20%', 'Lower-Middle', 'Middle', 'Upper-Middle', 'Top 20%'])),
  })),
});

const nativeCheckIn = object({
  ...entry, progressPct: nullable(number), note: nullable(string), alignmentRating: nullable(integer),
  blockers: nullable(strings), commitments: nullable(strings), promptAnswered: nullable(string),
});
const nativeMilestone = object({ id: uuid, title: string, completed: z.boolean(), completedDate: nullable(string) });
const nativeGoal = object({
  id: uuid, title: string, createdDate: string, notes: nullable(string), targetDate: nullable(string),
  completedDate: nullable(string), parentId: nullable(uuid), checkInIntervalDays: nullable(integer),
  status: nullable(z.enum(NATIVE_GOAL_STATUSES)), horizon: nullable(z.enum(NATIVE_HORIZONS)),
  category: nullable(z.enum(NATIVE_CATEGORIES)), goalType: nullable(z.enum(NATIVE_GOAL_TYPES)),
  priority: nullable(z.enum(['low', 'medium', 'high'])), milestones: nullable(z.array(nativeMilestone)),
  checkIns: nullable(z.array(nativeCheckIn)), mutedSignals: nullable(strings), deferredUntil: nullable(string),
  resolvedSignals: nullable(z.array(object({ title: string, severity: z.enum(['info', 'warn', 'alert']) }))),
  geneticEvidence: nullable(geneticEvidence),
});
const finiteFields = names => Object.fromEntries(names.split(' ').map(field => [field, nullable(number)]));
const dailyMetrics = object({
  ...entry, ...finiteFields('heartRate restingHeartRate hrv oxygenSaturation respiratoryRate vo2Max steps activeEnergy exerciseMinutes flightsClimbed sleepHours sleepDeepHours sleepRemHours sleepCoreHours cardioRecovery leanBodyMass bloodPressureSystolic bloodPressureDiastolic walkingSpeed walkingDistance walkingStepLength distanceCycling walkingAsymmetry walkingDoubleSupport stairSpeedUp stairSpeedDown walkingHRAverage walkingSteadiness standMinutes basalEnergy physicalEffort breathingDisturbances bloodGlucose bodyTemperature wristTemperature mindfulMinutes hkAlcoholicBeverages daylightMinutes environmentalAudioExposure headphoneAudioExposure'),
});
const saunaType = z.enum(['Infrared', 'Steam']);
const sauna = { saunaType, temperatureF: integer, durationMinutes: integer };
const knownArrays = {
  alcoholDrinks: z.array(object({ ...entry, name: string, oz: number, abv: number, count: number })),
  alcoholPresets: z.array(object({ id: uuid, name: string, oz: number, abv: number })),
  nicotineEntries: z.array(object({ ...entry, product: string, mgPerUnit: number, count: integer })),
  nicotinePresets: z.array(object({ id: uuid, name: string, mgPerUnit: number })),
  bloodTests: z.array(object({ ...entry, markers: z.record(string, number) })),
  eyeExams: z.array(object({
    ...entry, ...finiteFields('leftSphere leftCylinder rightSphere rightCylinder'),
    leftAxis: nullable(integer), rightAxis: nullable(integer),
  })),
  epigeneticTests: z.array(object({
    ...entry, chronologicalAge: number, biologicalAge: number, paceOfAging: nullable(number),
    organScores: nullable(z.record(string, number)),
  })),
  bodyEntries: z.array(object({ ...entry, ...finiteFields('weightLbs bodyFatPct') })),
  goals: z.array(nativeGoal),
  habits: z.array(object({ id: uuid, name: string, createdDate: string, parentGoalId: nullable(uuid),
    detail: nullable(string), icon: nullable(string), colorHex: nullable(string), archivedDate: nullable(string),
    category: optionalEnum([...NATIVE_CATEGORIES, 'wellness', 'general']), kind: optionalEnum(['positive', 'negative']),
    cadence: nullable(object({ period: z.enum(['daily', 'weekly']), target: integer })), geneticEvidence: nullable(geneticEvidence),
    completions: nullable(z.array(object({ ...entry, count: integer, note: string }))) })),
  healthMetrics: z.array(dailyMetrics), bloodDonations: z.array(object({
    ...entry, donationType: z.enum(['wholeBlood', 'plasma', 'platelets']), volumeML: integer, location: string,
  })),
  saunaSessions: z.array(object({ ...entry, ...sauna })),
  saunaPresets: z.array(object({ id: uuid, name: string, ...sauna })),
  genomeVisitNotes: z.array(object({ ...entry, providerLabel: nullable(string), findingKey: string, body: string, followUp: nullable(string) })),
};
const required = ['alcoholDrinks', 'alcoholPresets', 'nicotineEntries', 'nicotinePresets', 'bloodTests', 'eyeExams', 'epigeneticTests'];
const nativeStore = object({
  profile,
  ...Object.fromEntries(Object.entries(knownArrays).map(([key, schema]) => [key, required.includes(key) ? schema : nullable(schema)])),
  genomeScanRecord: nullable(object({
    scannedAt: number, apoeHaplotype: nullable(string),
    apoeStatus: optionalEnum(['beneficial', 'typical', 'concern', 'major_concern', 'not_found']),
    categoryRisks: z.record(string, object({ beneficial: integer, typical: integer, concern: integer, majorConcern: integer })),
  })),
  genomeActionStates: nullable(z.record(string, object({
    key: string, status: z.enum(['pending', 'in_progress', 'discussed', 'done', 'snoozed', 'dismissed']), updatedAt: string,
    note: nullable(string), linkedGoalId: nullable(uuid), linkedHabitId: nullable(uuid), linkedVisitNoteId: nullable(uuid),
  }))),
});

export function verifyMortalLoomStore(value) {
  if (!nativeStore.safeParse(value).success) throw storeFailure('invalid');
  return value;
}

// Same conservative trigger as MortalLoom's SharedStoreDocument. Don't merge
// an unexplained subset or revive ordinary deletes. A verified baseline is
// required; counts alone never deem a first sync invalid.
const monitoredCollections = ['goals', 'habits', 'bodyEntries', 'healthMetrics', 'alcoholDrinks',
  'nicotineEntries', 'bloodTests', 'bloodDonations', 'saunaSessions', 'eyeExams', 'epigeneticTests', 'genomeVisitNotes'];

const historyCounts = z.object(Object.fromEntries(monitoredCollections.map(key => [key, z.number().int().nonnegative()]))).strict();
const commitReceipt = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.number().int().positive(),
  history: z.object({ counts: historyCounts, hasUserData: z.boolean() }).strict(),
}).strict();

export function verifiedMortalLoomCommitReceipt(value) {
  const result = commitReceipt.safeParse(value);
  return result.success ? result.data : null;
}

export function summarizeMortalLoomHistory(value) {
  const counts = Object.fromEntries(monitoredCollections.map(key => [key, value[key]?.length ?? 0]));
  const hasUserData = value.profile.birthDate != null || value.genomeScanRecord != null ||
    monitoredCollections.some(key => key !== 'genomeVisitNotes' && counts[key] > 0);
  return { counts, hasUserData };
}

export function suspiciousMortalLoomContraction(previous, incoming) {
  let total = 0, erased = 0, reductions = 0;
  for (const key of monitoredCollections) {
    const before = previous.counts[key];
    const after = incoming.counts[key];
    total += before;
    reductions += Math.max(0, before - after);
    if (before >= 2 && after === 0) erased++;
  }
  return erased >= 2 || (total >= 3 && !incoming.hasUserData) || (reductions >= 10 && reductions * 2 >= total) ||
    (previous.counts.goals >= 3 && incoming.counts.goals === 0);
}
