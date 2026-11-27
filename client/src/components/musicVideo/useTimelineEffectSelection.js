import { useEffect, useMemo, useState } from 'react';
import { timelineShotAt } from '../../lib/musicVideoTimeline.js';
import { effectNaturalSec, effectTimeAt } from '../../lib/musicVideoTimelineEffects.js';
import { MUSIC_VIDEO_SHOT_GLITCH_LIMIT } from '../../../../server/lib/musicVideo/musicVideoTransitions.js';
import { NEW_GLITCH_STYLE } from './SceneGlitches.jsx';
import { timelineEffectLanes } from './ShotTimelineEffects.jsx';

// The selected effect plays from this long before it to this long after it.
const LOOP_LEAD_SEC = 0.75;
const roundMs = (t) => Math.round(t * 1000) / 1000;

export default function useTimelineEffectSelection({
  savedShots, shots, onScreenId, onPreview, playing, onEditShot, timeRef, effectOptions,
  durationSec, loopRef, libraryEl,
}) {
  // The shot whose effects are being configured under the timeline, and the in-shot effect selected in it.
  const [effectsOfId, setEffectsOfId] = useState(null);
  const [selectedFx, setSelectedFx] = useState(null);
  const [loopOn, setLoopOn] = useState(true);
  const effectsShot = effectOptions ? savedShots.find((shot) => shot.sceneId === effectsOfId) || null : null;
  const playheadShot = savedShots.find((shot) => shot.sceneId === onScreenId) || null;
  const playheadGlitches = Array.isArray(playheadShot?.scene.glitches) ? playheadShot.scene.glitches : [];
  // Move the player to `t` without changing whether it plays.
  const cue = (t) => onPreview?.(roundMs(Math.max(0, t)), playing);
  // A new in-shot effect at the playhead, selected and cued.
  const addEffect = (style = NEW_GLITCH_STYLE) => {
    const t = timeRef.current;
    const shot = timelineShotAt(savedShots, t);
    if (!shot || t >= shot.endSec || !onEditShot) return;
    const glitches = Array.isArray(shot.scene.glitches) ? shot.scene.glitches : [];
    if (glitches.length >= MUSIC_VIDEO_SHOT_GLITCH_LIMIT) return;
    const { atSec } = effectTimeAt(shot, t);
    onEditShot(shot.sceneId, { glitches: [...glitches, { atSec, style }] });
    setEffectsOfId(shot.sceneId);
    setSelectedFx({ sceneId: shot.sceneId, index: glitches.length });
    cue(shot.startSec + atSec - LOOP_LEAD_SEC);
  };
  const effectLanes = useMemo(() => (effectOptions ? timelineEffectLanes(shots, effectOptions) : null), [shots, effectOptions]);
  const selectEffects = (sceneId, toggle) => {
    setSelectedFx(null);
    setEffectsOfId((current) => (toggle && current === sceneId ? null : sceneId));
  };
  // The selected effect's stretch of the song with a little either side, the loop the preview plays.
  const fxShot = selectedFx ? savedShots.find((shot) => shot.sceneId === selectedFx.sceneId) : null;
  const fxGlitch = fxShot?.scene.glitches?.[selectedFx.index] || null;
  const loopRange = fxGlitch && Number.isFinite(fxGlitch.atSec) ? (() => {
    const start = fxShot.startSec + fxGlitch.atSec;
    const last = start + (fxGlitch.count > 1 && fxGlitch.everySec ? (fxGlitch.count - 1) * fxGlitch.everySec : 0);
    const end = Math.min(fxShot.endSec, last + (fxGlitch.lengthSec || effectNaturalSec(fxGlitch.style)));
    return { start: Math.max(0, start - LOOP_LEAD_SEC), end: Math.min(durationSec, end + LOOP_LEAD_SEC) };
  })() : null;
  loopRef.current = loopOn && loopRange && onPreview ? { ...loopRange, jump: (t) => onPreview(roundMs(t), true) } : null;
  const preview = () => { if (loopRange) cue(loopRange.start); };
  const selectEffect = (sceneId, index) => {
    setEffectsOfId(sceneId);
    setSelectedFx({ sceneId, index });
    const shot = savedShots.find((entry) => entry.sceneId === sceneId);
    const at = shot?.scene.glitches?.[index]?.atSec;
    if (Number.isFinite(at)) cue(shot.startSec + at - LOOP_LEAD_SEC);
  };
  // The side panel starts at its top whenever it changes between the library and a shot's settings.
  const panelKey = effectsShot ? `${effectsShot.sceneId}:${selectedFx?.index ?? ''}` : '';
  useEffect(() => { if (libraryEl) libraryEl.scrollTop = 0; }, [libraryEl, panelKey]);
  return { effectsShot, selectedFx, fxGlitch, playheadShot, playheadGlitches, addEffect, loopOn,
    setLoopOn, loopRange, preview, selectEffects, selectEffect, setEffectsOfId, setSelectedFx,
    effectLanes };
}
