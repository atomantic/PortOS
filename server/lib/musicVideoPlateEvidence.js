import { activeMusicVideoSubjects } from './musicVideoCastSelection.js';
import { shotCameraRuleText, shotOmitsOwnedCameraDetail } from './musicVideoShotSheet.js';
import { RENDER_DEFECTS } from './imageRenderQuality.js';
/** Asset-bound still-image admission for authored shots. Shared with the comparison UI. */
import { extractJson } from './jsonExtract.js';
import { canonicalStringify } from './objects.js';

/** An end-frame take is reviewed against the end prompt; every other still stays on the start prompt. */
export function plateFrameRole(take) {
  return take?.kind === 'endImage' ? 'end' : 'start';
}

const savedFramePrompt = (scene, role) => (role === 'end' ? scene?.endFramePrompt || '' : scene?.framePrompt || scene?.prompt || '');

export function plateRequirementBasis(scene, role = 'start', project = null) {
  const cameraId = scene.shotSheet?.cameraId || null;
  const camera = {
    ...(cameraId ? { camera: { id: cameraId, holder: scene.shotSheet?.holder || null, rule: shotCameraRuleText(project, scene) } } : {}),
    ...(scene.camera ? { cameraMove: scene.camera } : {}),
  };
  // The start-frame hash is the one already stored on takes. An end frame adds
  // its own prompt so editing the start prompt cannot stale it, and the reverse.
  if (role === 'end') {
    return canonicalStringify({ frameRole: 'end', direction: scene.direction || null, endFramePrompt: scene.endFramePrompt || '', startSec: scene.startSec, endSec: scene.endSec, ...camera });
  }
  return canonicalStringify({ direction: scene.direction || null, framePrompt: scene.framePrompt || scene.prompt || '', startSec: scene.startSec, endSec: scene.endSec, ...camera });
}

const sheetNames = (list) => (Array.isArray(list) ? list : [list]).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean);

/**
 * Details a character must always show (a watch, a bracelet, a camera on a strap),
 * taken from the video's subjects: required for each character the shot sheet names,
 * and conditional for the point-of-view holder, whose hands may be all that shows.
 */
function plateDetailRequirements(scene, subjects = [], project = null) {
  const sheet = scene?.shotSheet || {};
  const inShot = new Set(sheetNames(sheet.characters));
  const holder = new Set(sheetNames(sheet.holder));
  const lines = [];
  for (const subject of activeMusicVideoSubjects({ subjects: Array.isArray(subjects) ? subjects : [] })) {
    if (subject?.kind !== 'character' || !Array.isArray(subject.requiredDetails)) continue;
    const name = String(subject.name || '').trim();
    const key = name.toLowerCase();
    const prefix = inShot.has(key) ? `${name} shows` : holder.has(key) ? `If ${name}'s hands or arms are visible, they show` : null;
    if (!prefix) continue;
    for (const detail of subject.requiredDetails) {
      const text = String(detail || '').trim();
      // The camera taking the picture is not a prop on the person holding it.
      if (!text || shotOmitsOwnedCameraDetail(project, scene, name, text)) continue;
      lines.push(`${prefix}: ${text}`);
    }
  }
  // The same camera block the frame prompt sends, so the check judges that rule.
  const camera = shotCameraRuleText(project, scene);
  if (camera) lines.push(camera);
  return [...new Set(lines)].map((requirement, index) => ({ id: `detail-${index + 1}`, requirement }));
}

const isDetailCheck = (check) => typeof check?.id === 'string' && /^detail-\d+$/.test(check.id);

/** Still evidence proves starting-state support, never completion of timed actions. */
export function plateRequirements(scene, subjects = [], role = 'start', project = null) {
  const own = sceneRequirements(scene, role);
  return [...own.slice(0, -1), ...plateDetailRequirements(scene, subjects, project), own[own.length - 1]];
}

function sceneRequirements(scene, role = 'start') {
  const direction = scene.direction || {};
  const contract = direction.actionContract;
  if (!contract) return [
    { id: 'plate-prompt', requirement: `Matches the saved still prompt: ${savedFramePrompt(scene, role)}` },
    { id: 'render-quality', requirement: `Rendering defect check: no ${RENDER_DEFECTS}` },
  ];
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
  return [...requirements.map((requirement, index) => ({ id: `plate-${index + 1}`, requirement })),
    { id: 'render-quality', requirement: `Rendering defect check: no ${RENDER_DEFECTS}` }];
}

/** A selection or shot edit cannot borrow evidence from a different image or intent. */
// Character detail checks come from the video's subjects at review time, so the
// shot alone cannot re-derive them; they count as long as each one is well formed.
export function currentPlateEvidence(scene, take, project = null) {
  const evidence = take?.plateEvidence;
  const role = plateFrameRole(take);
  if (!evidence || !take || evidence.assetId !== take.assetId || evidence.basis !== plateRequirementBasis(scene, role, project) || !Array.isArray(evidence.checks)) return null;
  const requirements = sceneRequirements(scene, role);
  const wellFormed = (check) => ['pass', 'fail', 'unverified'].includes(check?.status) && typeof check.note === 'string' && check.note.trim();
  const details = evidence.checks.filter(isDetailCheck);
  if (evidence.checks.length !== requirements.length + details.length || new Set(evidence.checks.map((check) => check?.id)).size !== evidence.checks.length
    || details.some((check) => !wellFormed(check) || typeof check.requirement !== 'string')
    || requirements.some(({ id, requirement }) => !evidence.checks.some((check) => check?.id === id && check.requirement === requirement && wellFormed(check)))) return null;
  const verdict = evidence.checks.some((check) => check.status === 'unverified') ? 'unverified'
    : evidence.checks.some((check) => check.status === 'fail') ? 'fail' : 'pass';
  return evidence.verdict === verdict ? evidence : null;
}

/** A plate that passed alone but disagrees with its neighbor stays out of this run's video steps. */
export function plateAdjacencyFailed(evidence, runId) {
  return evidence?.adjacency?.runId === runId && evidence.adjacency.verdict === 'fail';
}

/** Footage shots with a reviewable plate, in cut order; code, card and still shots never join the strip. */
export function footagePlateScenes(project) {
  const medium = (scene) => project.treatment?.shotDirections?.find((entry) => entry.sceneId === scene.sceneId)?.medium;
  return (project.scenes || []).filter((scene) => scene.direction?.actionContract && (medium(scene) ?? 'generated-footage') === 'generated-footage')
    .sort((a, b) => a.startSec - b.startSec);
}

export const selectedPlateTake = (scene) => scene.takes?.find((entry) => entry.kind === 'image' && entry.assetId === scene.referenceImageId && entry.status !== 'rejected');

/** Adjacency evidence for strip[index], valid only for the same neighbor pair within one run. */
export function currentAdjacency(strip, index, runId, resumedAt = '') {
  const adjacency = selectedPlateTake(strip[index])?.plateEvidence?.adjacency;
  if (adjacency?.runId !== runId || adjacency.key !== `${strip[index - 1].referenceImageId}>${strip[index].referenceImageId}`) return null;
  return adjacency.verdict === 'unverified' && adjacency.reviewedAt < resumedAt ? null : adjacency;
}

/** Invalid or incomplete strip responses fail closed as unverified for every compared scene. */
export function plateStripFindings(strip, text) {
  const { value } = extractJson(String(text || ''), { shapePredicate: (candidate) => candidate && Array.isArray(candidate.scenes) });
  return strip.slice(1).map((scene) => {
    const matches = Array.isArray(value?.scenes) ? value.scenes.filter((entry) => entry?.sceneId === scene.sceneId) : [];
    const result = matches.length === 1 ? matches[0] : null;
    const usable = ['pass', 'fail', 'unverified'].includes(result?.status) && typeof result.note === 'string' && result.note.trim();
    return { sceneId: scene.sceneId, verdict: usable ? result.status : 'unverified', note: usable ? result.note.trim().slice(0, 1000) : 'The reviewer supplied no usable adjacency evidence' };
  });
}

export function selectedPlatePasses(scene, runId, project = null) {
  const take = scene.takes?.find((entry) => entry.kind === 'image' && entry.assetId === scene.referenceImageId && entry.status !== 'rejected');
  const evidence = currentPlateEvidence(scene, take, project);
  return evidence?.runId === runId && !plateAdjacencyFailed(evidence, runId) && evidence.checks.every((check) => check.status === 'pass'
    || (check.id === 'render-quality' && renderQualityAcknowledged(scene, take, project)));
}

/** Explicit acknowledgement is bound to one image, exact shot intent and visible defect. */
export function renderQualityAcknowledged(scene, take, project = null) {
  const evidence = currentPlateEvidence(scene, take, project);
  const defect = evidence?.checks.find((check) => check.id === 'render-quality' && check.status === 'fail');
  const ack = take?.renderQualityAcknowledgement;
  return !!defect && ack?.basis === evidence.basis && ack?.note === defect.note && !!ack?.reviewer;
}

/** Invalid, absent or incomplete responses fail closed with concrete unverified checks. */
export function plateReviewEvidence(scene, assetId, runId, text, used = {}, subjects = [], frameRole = 'start', project = null) {
  const requirements = plateRequirements(scene, subjects, frameRole, project);
  const { value } = extractJson(String(text || ''), { shapePredicate: (candidate) => candidate && Array.isArray(candidate.checks) });
  const checks = requirements.map(({ id, requirement }) => {
    const matches = Array.isArray(value?.checks) ? value.checks.filter((check) => check?.id === id) : [];
    const result = matches.length === 1 ? matches[0] : null;
    const usable = ['pass', 'fail', 'unverified'].includes(result?.status) && typeof result.note === 'string' && result.note.trim();
    return { id, requirement, status: usable ? result.status : 'unverified', note: usable ? result.note.trim().slice(0, 1000) : 'The reviewer supplied no usable evidence for this requirement' };
  });
  return { assetId, runId, basis: plateRequirementBasis(scene, frameRole, project), checks,
    verdict: checks.some((check) => check.status === 'unverified') ? 'unverified' : checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
    ...used, reviewedAt: new Date().toISOString() };
}
