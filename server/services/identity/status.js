import { getGenomeSummary } from '../genome.js';
import { getTasteProfile } from '../taste-questionnaire.js';
import {
  IDENTITY_FILE,
  CHRONOTYPE_FILE,
  LONGEVITY_FILE,
  GOALS_FILE,
  DEFAULT_IDENTITY,
  DEFAULT_CHRONOTYPE,
  DEFAULT_LONGEVITY,
  DEFAULT_GOALS,
  ensureIdentityDir,
  loadJSON
} from './store.js';

export async function getIdentityStatus() {
  await ensureIdentityDir();
  const identity = await loadJSON(IDENTITY_FILE, DEFAULT_IDENTITY);

  // Check genome status
  const genomeSummary = await getGenomeSummary();
  if (genomeSummary?.uploaded) {
    const markerCount = genomeSummary.markerCount || 0;
    identity.sections.genome = {
      status: markerCount > 0 ? 'active' : 'pending',
      label: 'Genome',
      markerCount,
      updatedAt: genomeSummary.uploadedAt
    };
  } else {
    identity.sections.genome = { status: 'unavailable', label: 'Genome', updatedAt: null };
  }

  // Check chronotype status
  const chronotype = await loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE);
  if (chronotype.derivedAt) {
    identity.sections.chronotype = {
      status: 'active',
      label: 'Chronotype',
      type: chronotype.type,
      confidence: chronotype.confidence,
      updatedAt: chronotype.derivedAt
    };
  } else {
    identity.sections.chronotype = {
      status: genomeSummary?.uploaded ? 'pending' : 'unavailable',
      label: 'Chronotype',
      updatedAt: null
    };
  }

  // Check longevity status
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);
  if (longevity.derivedAt) {
    const markerCount = Object.keys(longevity.longevityMarkers).length +
      Object.keys(longevity.cardiovascularMarkers).length;
    identity.sections.longevity = {
      status: 'active',
      label: 'Longevity',
      markerCount,
      adjustedLifeExpectancy: longevity.lifeExpectancy?.adjusted,
      confidence: longevity.confidence,
      updatedAt: longevity.derivedAt
    };
  } else {
    identity.sections.longevity = {
      status: genomeSummary?.uploaded ? 'pending' : 'unavailable',
      label: 'Longevity',
      updatedAt: null
    };
  }

  // Check aesthetics (taste profile) status
  const tasteProfile = await getTasteProfile();
  if (tasteProfile?.completedCount > 0) {
    identity.sections.aesthetics = {
      status: tasteProfile.overallPercentage >= 100 ? 'active' : 'pending',
      label: 'Aesthetics',
      completedSections: tasteProfile.completedCount,
      totalSections: tasteProfile.totalSections,
      updatedAt: tasteProfile.lastSessionAt
    };
  } else {
    identity.sections.aesthetics = { status: 'unavailable', label: 'Aesthetics', updatedAt: null };
  }

  // Goals status — check goals.json for user-defined goals
  const goalsData = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const activeGoals = goalsData.goals?.filter(g => g.status === 'active') || [];
  if (activeGoals.length > 0) {
    identity.sections.goals = {
      status: 'active',
      label: 'Goals',
      goalCount: activeGoals.length,
      hasBirthDate: !!goalsData.birthDate,
      updatedAt: goalsData.updatedAt
    };
  } else if (goalsData.birthDate) {
    identity.sections.goals = {
      status: 'pending',
      label: 'Goals',
      hasBirthDate: true,
      updatedAt: goalsData.updatedAt
    };
  } else {
    identity.sections.goals = { status: 'unavailable', label: 'Goals', updatedAt: null };
  }

  identity.updatedAt = new Date().toISOString();

  return identity;
}
