/**
 * Client helpers for the Music Video cameo roster (#14821). The record rules
 * live in server/lib/musicVideoCameos.js; these shape the roster editor's input
 * and apply the server's answer to the open board.
 */

// The scene fields a roster edit can change: the link and the still it fills.
const CAMEO_SCENE_FIELDS = ['cameoId', 'cameoVariantId', 'cameoLabel', 'referenceImageId', 'takes'];

/**
 * Apply the scenes a roster edit answered onto the board's scenes, touching only
 * the cameo link and the start frame it fills, so an unrelated edit made while
 * the request ran is kept.
 */
export function mergeCameoScenes(current = [], answered = []) {
  const byId = new Map((answered || []).map((scene) => [scene.sceneId, scene]));
  return (current || []).map((scene) => {
    const next = byId.get(scene.sceneId);
    if (!next) return scene;
    const merged = { ...scene };
    for (const field of CAMEO_SCENE_FIELDS) {
      if (field in next) merged[field] = next[field];
      else delete merged[field];
    }
    if (merged.referenceImageId === scene.referenceImageId) merged.takes = scene.takes;
    return merged;
  });
}

/**
 * One cameo per non-empty line: `Name`, or `Name | on-screen label`, so a long
 * roll call can be pasted in one go. Exact duplicate names in the paste are kept once.
 */
export function parseCameoLines(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const [rawName, ...rest] = line.split('|');
    const name = rawName.trim().slice(0, 120);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const label = rest.join('|').trim().slice(0, 120);
    out.push(label ? { name, label } : { name });
  }
  return out;
}
