/**
 * FableLoom Board view — one path through an episode's scene graph laid out as
 * storyboard panels. The path starts at the episode's start scene and follows
 * the first choice at each fork unless the reader picked another (`via`, the
 * chosen transition ids, kept in the URL). A fork's other choices travel with
 * its panel as alternates. Consecutive scenes of the same dramatic scene form
 * one beat, as panels do on a storyboard. Read-only; browser-safe.
 */

const sceneSeconds = (node) => (Number.isFinite(node?.shot?.durationSeconds) ? node.shot.durationSeconds : null);

/**
 * `{ beats, totalSeconds, end }`: beats of panels in path order. A panel is
 * `{ node, number, seconds, choices, loopsTo }`, where `choices` lists every
 * transition to a scene that exists (`picked` marks the one the path takes)
 * and `loopsTo` names a scene the path already showed, where it stops. `end`
 * is `ending`, `loop`, `open` (a scene with nowhere to go) or `empty`.
 */
export function fableLoomBoardPath(episode, via = []) {
  const nodes = Array.isArray(episode?.nodes) ? episode.nodes : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chosen = new Set(via);
  const beats = [];
  const seen = new Set();
  let node = byId.get(episode?.startNodeId) || null;
  let end = node ? 'open' : 'empty';
  let number = 0;
  let totalSeconds = 0;
  while (node) {
    seen.add(node.id);
    number += 1;
    const choices = (node.transitions || []).filter((t) => byId.has(t.targetNodeId));
    const next = choices.find((t) => chosen.has(t.id)) || choices[0] || null;
    const loopsTo = next && seen.has(next.targetNodeId) ? next.targetNodeId : null;
    const seconds = sceneSeconds(node);
    totalSeconds += seconds || 0;
    const beatId = node.shot?.dramaticSceneId || node.id;
    if (beats.at(-1)?.id !== beatId) beats.push({ id: beatId, title: node.shot?.dramaticSceneTitle || node.title || '', panels: [] });
    beats.at(-1).panels.push({
      node,
      number,
      seconds,
      loopsTo,
      choices: choices.map((t) => ({
        transitionId: t.id, targetNodeId: t.targetNodeId, intent: t.intent || '', picked: t === next,
        title: byId.get(t.targetNodeId).title || '', image: byId.get(t.targetNodeId).image || null,
      })),
    });
    if (node.isEnding) { end = 'ending'; break; }
    if (!next) break;
    if (loopsTo) { end = 'loop'; break; }
    node = byId.get(next.targetNodeId);
  }
  return { beats, totalSeconds, end };
}

/**
 * The `via` list after picking `transitionId` at its scene: that scene's other
 * choices are dropped, so one pick per fork. Picks after the fork stay; they
 * still apply wherever the new path reaches their scenes.
 */
export function fableLoomBoardPick(episode, via, transitionId) {
  const owner = (episode?.nodes || []).find((node) => (node.transitions || []).some((t) => t.id === transitionId));
  const siblings = new Set((owner?.transitions || []).map((t) => t.id));
  return [...via.filter((id) => !siblings.has(id)), transitionId];
}
