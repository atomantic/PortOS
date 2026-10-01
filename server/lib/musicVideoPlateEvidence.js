/** Asset-bound still-image admission for authored shots. Shared with the comparison UI. */
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
