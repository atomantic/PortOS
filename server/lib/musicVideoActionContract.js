/** Versioned dramatic intent shared by treatment, generation and shot inspection. */
export const SHOT_ACTION_TEXT_LIMITS = Object.freeze({
  purpose: 1000, startEmotion: 500, endEmotion: 500, activeSpeaker: 120,
});
export const SHOT_ACTION_LIST_FIELDS = Object.freeze(['cameraConstraints', 'continuityRequirements', 'acceptanceCriteria']);
const CONTRACT_KEYS = new Set(['version', ...Object.keys(SHOT_ACTION_TEXT_LIMITS), ...SHOT_ACTION_LIST_FIELDS, 'actions', 'reactions']);
const EVENT_KEYS = new Set(['startSec', 'endSec', 'subject', 'description']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (value) => Number.isFinite(value) && value >= 0 && value <= 36000;
const isText = (value, max) => typeof value === 'string' && value.length <= max;

/** Shape validation; null means an explicit clear. Returns a human-readable problem or null. */
export function shotActionContractProblem(contract, scene = null) {
  if (contract == null) return null;
  if (!isObject(contract) || contract.version !== 1 || Object.keys(contract).some((key) => !CONTRACT_KEYS.has(key))) return 'Shot intent must be a version 1 action contract';
  if (!isText(contract.purpose, 1000) || !contract.purpose.trim()) return 'Shot intent needs a purpose';
  for (const [key, max] of Object.entries(SHOT_ACTION_TEXT_LIMITS)) {
    if (contract[key] !== undefined && !isText(contract[key], max)) return `Invalid ${key} in shot intent`;
  }
  for (const key of SHOT_ACTION_LIST_FIELDS) {
    if (contract[key] !== undefined && (!Array.isArray(contract[key]) || contract[key].length > 12
      || contract[key].some((text) => !isText(text, 500) || !text.trim()))) return `Invalid ${key} in shot intent`;
  }
  const spanSec = scene ? scene.endSec - scene.startSec : null;
  if (scene && (!isTime(scene.startSec) || !isTime(scene.endSec) || !(spanSec > 0))) return 'Shot intent needs a finite, positive scene time span';
  for (const key of ['actions', 'reactions']) {
    const events = contract[key] ?? [];
    if (!Array.isArray(events) || events.length > 24) return `Invalid ${key} in shot intent`;
    for (const event of events) {
      if (!isObject(event) || Object.keys(event).some((field) => !EVENT_KEYS.has(field))
        || !isTime(event.startSec) || !isTime(event.endSec) || !(event.endSec > event.startSec)
        || !isText(event.subject, 120) || !event.subject.trim()
        || !isText(event.description, 1000) || !event.description.trim()) return 'Actions and reactions need a subject, description and finite increasing times';
      if (scene && event.endSec > spanSec) return `Shot ${key} must fit inside its ${spanSec.toFixed(3)}s scene`;
    }
  }
  return null;
}

/** Assert again at generation: scene times can change after the treatment was saved. */
export function assertShotActionContract(scene) {
  const problem = shotActionContractProblem(scene?.direction?.actionContract, scene);
  if (problem) {
    const error = new Error(problem);
    error.code = 'MUSIC_VIDEO_ACTION_CONTRACT_INVALID';
    error.status = 422;
    throw error;
  }
}

/** Compile intent and actual song cues to provider clip time. offsetSec is the performance edit in-point. */
export function shotActionPrompt(project, scene, { frame = false, offsetSec = 0 } = {}) {
  const contract = scene?.direction?.actionContract;
  if (contract == null) return '';
  assertShotActionContract(scene);
  const time = (sec) => `${(sec + offsetSec).toFixed(3)}s`;
  const lines = [
    `Purpose: ${contract.purpose}`,
    contract.startEmotion ? `Starting emotion: ${contract.startEmotion}` : '',
    !frame && contract.endEmotion ? `Ending emotion: ${contract.endEmotion}` : '',
    contract.activeSpeaker ? `Active speaker: ${contract.activeSpeaker}` : '',
  ];
  for (const kind of ['actions', 'reactions']) {
    for (const event of contract[kind] || []) lines.push(`${kind === 'actions' ? 'Action' : 'Reaction'} ${time(event.startSec)}–${time(event.endSec)}: ${event.subject} — ${event.description}`);
  }
  for (const [key, label] of [['cameraConstraints', 'Camera'], ['continuityRequirements', 'Must preserve'], ['acceptanceCriteria', 'Acceptance']]) {
    for (const item of contract[key] || []) lines.push(`${label}: ${item}`);
  }
  if (!frame) {
    const window = (item) => Number.isFinite(item.startSec) && Number.isFinite(item.endSec) && item.endSec > scene.startSec && item.startSec < scene.endSec;
    for (const cue of (project.lyricCues || []).filter(window).slice(0, 32)) {
      lines.push(`Lyric ${time(Math.max(0, cue.startSec - scene.startSec))}–${time(Math.min(scene.endSec, cue.endSec) - scene.startSec)}: ${cue.text}`);
      for (const word of (cue.words || []).filter(window).slice(0, 64)) lines.push(`Word ${time(Math.max(0, word.startSec - scene.startSec))}–${time(Math.min(scene.endSec, word.endSec) - scene.startSec)}: ${word.w}`);
    }
    const onsets = [...new Set(Object.values(project.audioAnalysis?.features?.onsets || {}).flat())]
      .filter((sec) => Number.isFinite(sec) && sec >= scene.startSec && sec < scene.endSec).sort((a, b) => a - b).slice(0, 64);
    if (onsets.length) lines.push(`Musical onsets: ${onsets.map((sec) => time(sec - scene.startSec)).join(', ')}`);
  }
  return `${frame ? 'Plate requirements (prepare the starting state for these actions)' : 'Shot intent (clip-relative seconds)'}:\n${lines.filter(Boolean).join('\n')}\nEnd shot intent.`;
}

/** Refresh only the generated intent block, retaining caller prose such as approximate motion cues. */
export function withShotActionPrompt(prompt, project, scene, options = {}) {
  const base = String(prompt || '').replace(/\nShot intent \(clip-relative seconds\):[\s\S]*?\nEnd shot intent\./g, '');
  return [base, shotActionPrompt(project, scene, options)].filter(Boolean).join('\n');
}
