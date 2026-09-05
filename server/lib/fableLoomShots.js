/** Pure timing and grouping contracts for short, individually rendered shots. */
export const FABLELOOM_SHOT_MIN_SECONDS = 5;
export const FABLELOOM_SHOT_MAX_SECONDS = 10;

export function sanitizeShot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    dramaticSceneId: String(raw.dramaticSceneId || '').slice(0, 80),
    dramaticSceneTitle: String(raw.dramaticSceneTitle || '').slice(0, 300),
    durationSeconds: Number.isFinite(raw.durationSeconds) ? raw.durationSeconds : 8,
    framing: String(raw.framing || '').slice(0, 500),
  };
}

// Shared with the structured shot schema so every accepted speaker is counted.
export const isShotSpeakerCue = (text) => typeof text === 'string' && !/^(?:INT\.|EXT\.|INT\/EXT\.|EST\.|CUT TO|FADE|TELEPLAY)/.test(text) && /^[\p{Lu}\d][\p{Lu}\d .’'()—\-/:&]{0,69}$/u.test(text);

/** Fountain-style cues; action and parentheticals consume no spoken-word budget. */
export function shotDialogueWords(prose = '') {
  let speaking = false;
  let words = 0;
  for (const line of prose.split('\n')) {
    const text = line.trim();
    if (!text) { speaking = false; continue; }
    if (/^(?:INT\.|EXT\.|INT\/EXT\.|EST\.|CUT TO|FADE|TELEPLAY)/.test(text)) { speaking = false; continue; }
    if (!speaking && isShotSpeakerCue(text)) { speaking = true; continue; }
    if (speaking && !/^\([^)]*\)$/.test(text)) words += text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length || 0;
  }
  return words;
}

export const estimatedShotSeconds = (prose) => Math.ceil((1.5 + shotDialogueWords(prose) / 2.2) * 10) / 10;

export function analyzeEpisodeShots(episode) {
  const issues = [];
  const shots = (episode?.nodes || []).filter((node) => node.shot);
  for (const node of shots) {
    const duration = node.shot.durationSeconds;
    if (duration < 5 || duration > 10 || !Number.isFinite(duration)) issues.push({ nodeId: node.id, code: 'SHOT_DURATION', message: `${node.title}: choose a 5–10 second shot duration.` });
    if (estimatedShotSeconds(node.prose) > duration) issues.push({ nodeId: node.id, code: 'SHOT_DIALOGUE_OVERFLOW', message: `${node.title}: dialogue needs about ${estimatedShotSeconds(node.prose)} seconds in a ${duration}-second shot. Split or shorten it.` });
    if (node.playbackMode === 'decision' && shotDialogueWords(node.prose)) issues.push({ nodeId: node.id, code: 'SHOT_LOOP_DIALOGUE', message: `${node.title}: put scripted dialogue before the silent decision loop; live conversation is separate.` });
  }
  return { issues, stats: { shotCount: shots.length, dramaticSceneCount: new Set(shots.map((node) => node.shot.dramaticSceneId)).size, totalAssetSeconds: shots.reduce((sum, node) => sum + node.shot.durationSeconds, 0), ready: shots.length > 0 && shots.length === episode.nodes.length && !issues.length } };
}
