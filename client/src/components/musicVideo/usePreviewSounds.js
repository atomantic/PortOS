import { useEffect, useMemo, useState } from 'react';
import { songClipSound } from '../../../../server/lib/musicVideo/musicVideoClipSound.js';
import { getVideoHistoryItem } from '../../services/apiImageVideo.js';
import { trackAudioUrl } from '../../services/apiTracks.js';
import { clipOffsetSec } from '../../lib/musicVideoLayers.js';
import { clipSoundShots } from './ShotTimelineAudioLayers.jsx';
import { clipTimeAt } from './animaticTiming.js';

/**
 * Everything the live preview plays over the song (useAudioLayerPlayback's
 * entries): the timeline's audio layers, and each clip-sound shot's audio
 * from its selected clip, with the shot's level, fades and song dip. A clip's
 * file is looked up from video history once per clip.
 */
export default function usePreviewSounds(project) {
  const shots = useMemo(() => clipSoundShots(project?.scenes), [project?.scenes]);
  // The distinct clips, as one key: the lookups rerun only when that set changes.
  const clipKey = [...new Set(shots.map((scene) => scene.videoHistoryId))].sort().join('\n');
  const [clipFiles, setClipFiles] = useState({ key: '', srcs: new Map() });
  useEffect(() => {
    if (!clipKey) return undefined;
    let active = true;
    Promise.all(clipKey.split('\n').map((id) => getVideoHistoryItem(id, { silent: true })
      .then((entry) => [id, typeof entry?.filename === 'string' && entry.filename.trim() ? `/data/videos/${entry.filename.trim()}` : null])
      .catch(() => [id, null])))
      .then((pairs) => { if (active) setClipFiles({ key: clipKey, srcs: new Map(pairs) }); });
    return () => { active = false; };
  }, [clipKey]);

  return useMemo(() => {
    const layers = (Array.isArray(project?.audioLayers) ? project.audioLayers : [])
      .filter((layer) => layer?.filename && !layer.muted)
      .map((layer) => ({ id: `layer:${layer.id}`, src: trackAudioUrl(layer.filename), startSec: layer.startSec, durationSec: layer.durationSec, volume: layer.volume }));
    const srcs = clipFiles.key === clipKey ? clipFiles.srcs : new Map();
    const clips = shots.flatMap((scene) => {
      const src = srcs.get(scene.videoHistoryId);
      if (!src) return [];
      const sound = songClipSound(scene);
      // A negative clip offset holds the first frame before the clip runs; its sound starts with the motion.
      const lead = Math.max(0, -clipOffsetSec(scene));
      const startSec = scene.startSec + lead;
      return [{
        id: `clip:${scene.sceneId}`, src, startSec, durationSec: scene.endSec - startSec,
        volume: sound.volume, musicLevel: sound.musicLevel, fadeInSec: sound.fadeInSec || 0, fadeOutSec: sound.fadeOutSec || 0,
        sourceAt: (t, fileSec) => clipTimeAt(scene, t, fileSec),
      }];
    });
    return [...layers, ...clips];
  }, [project?.audioLayers, shots, clipFiles, clipKey]);
}
