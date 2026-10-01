/** Asset-bound still-image admission for authored shots. Shared with the comparison UI. */
import { extractJson } from './jsonExtract.js';
import { canonicalStringify } from './objects.js';

export function plateRequirementBasis(scene) {
  return canonicalStringify({ direction: scene.direction || null, framePrompt: scene.framePrompt || '', startSec: scene.startSec, endSec: scene.endSec });
}

/** Still evidence proves starting-state support, never completion of timed actions. */
export function plateRequirements(scene) {
  const direction = scene.direction || {};
  const contract = direction.actionContract;
  if (!contract) return [];
  const subjects = [...new Set([contract.activeSpeaker, ...(contract.actions || []).map((event) => event.subject), ...(contract.reactions || []).map((event) => event.subject)].filter(Boolean))];
  const requirements = [
    ...subjects.map((subject) => `Subject visible: ${subject}`),
    ...[...(contract.actions || []), ...(contract.reactions || [])].map((event) => `Starting pose, props and space must support ${event.subject}: ${event.description}`),
    ...(contract.cameraConstraints || []).map((text) => `Camera: ${text}`),
    ...(contract.continuityRequirements || []).map((text) => `Continuity: ${text}`),
    ...(contract.acceptanceCriteria || []).map((text) => `Visible starting-state requirement: ${text}`),
    ...(direction.focalSubject ? [`Focal subject: ${direction.focalSubject}`] : []),
    ...(direction.framing ? [`Framing: ${direction.framing}`] : []),
    ...(contract.startEmotion ? [`Starting emotion: ${contract.startEmotion}`] : []),
    `Composition can support shot purpose: ${contract.purpose}`,
  ];
  return requirements.map((requirement, index) => ({ id: `plate-${index + 1}`, requirement }));
}

/** A selection or shot edit cannot borrow evidence from a different image or intent. */
export function currentPlateEvidence(scene, take) {
  const evidence = take?.plateEvidence;
  if (!evidence || !take || evidence.assetId !== take.assetId || evidence.basis !== plateRequirementBasis(scene) || !Array.isArray(evidence.checks)) return null;
  const requirements = plateRequirements(scene);
  if (evidence.checks.length !== requirements.length || new Set(evidence.checks.map((check) => check?.id)).size !== requirements.length
    || requirements.some(({ id, requirement }) => !evidence.checks.some((check) => check?.id === id && check.requirement === requirement
      && ['pass', 'fail', 'unverified'].includes(check.status) && typeof check.note === 'string' && check.note.trim()))) return null;
  const verdict = evidence.checks.some((check) => check.status === 'unverified') ? 'unverified'
    : evidence.checks.some((check) => check.status === 'fail') ? 'fail' : 'pass';
  return evidence.verdict === verdict ? evidence : null;
}

export function selectedPlatePasses(scene, runId) {
  if (!scene.direction?.actionContract) return true;
  const take = scene.takes?.find((entry) => entry.kind === 'image' && entry.assetId === scene.referenceImageId && entry.status !== 'rejected');
  const evidence = currentPlateEvidence(scene, take);
  const requirements = plateRequirements(scene);
  return evidence?.runId === runId && evidence.verdict === 'pass' && requirements.every(({ id }) => evidence.checks?.some((check) => check.id === id && check.status === 'pass'));
}

/** Invalid, absent or incomplete responses fail closed with concrete unverified checks. */
export function plateReviewEvidence(scene, assetId, runId, text, used = {}) {
  const requirements = plateRequirements(scene);
  const { value } = extractJson(String(text || ''), { shapePredicate: (candidate) => candidate && Array.isArray(candidate.checks) });
  const checks = requirements.map(({ id, requirement }) => {
    const matches = Array.isArray(value?.checks) ? value.checks.filter((check) => check?.id === id) : [];
    const result = matches.length === 1 ? matches[0] : null;
    const usable = ['pass', 'fail', 'unverified'].includes(result?.status) && typeof result.note === 'string' && result.note.trim();
    return { id, requirement, status: usable ? result.status : 'unverified', note: usable ? result.note.trim().slice(0, 1000) : 'The reviewer supplied no usable evidence for this requirement' };
  });
  return { assetId, runId, basis: plateRequirementBasis(scene), checks,
    verdict: checks.some((check) => check.status === 'unverified') ? 'unverified' : checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
    ...used, reviewedAt: new Date().toISOString() };
}
