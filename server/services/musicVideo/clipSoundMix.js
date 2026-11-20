/**
 * Music Video — the song's audio mix for a final render: the master, an
 * optional sound-design bed under it (soundBed.js) and any song shot's own
 * clip sound over it (lib/musicVideo/musicVideoClipSound.js), with the song
 * dipped to the shot's `musicLevel` while that sound plays.
 *
 * Pure: returns ffmpeg inputs and filter strings for the shared bed chain
 * (videoTimeline/audioBedMix.js), so footage and document renders mix the
 * same way. Callers own their input numbering.
 */

import { AUDIO_NORM, buildAudioBedMix, fmtSec } from '../videoTimeline/audioBedMix.js';

// A short ramp on each end of a clip's sound so the cut into it never clicks.
const EDGE_FADE_SEC = 0.03;

export function clipSoundVoice({ sceneId, assetPath, offsetSec, startSec, durationSec, rate, clipSound }) {
  const fade = Math.min(EDGE_FADE_SEC, durationSec / 4);
  return { sceneId, assetPath, offsetSec, startSec, durationSec, ...(rate != null ? { rate } : {}),
    volume: clipSound.volume, musicLevel: clipSound.musicLevel, fadeInSec: fade, fadeOutSec: fade };
}

/**
 * The clip sounds a cut plays, from its laid-out sections (`{ c, startSec,
 * endSec }`, buildMusicVideoFfmpegArgs's plan) on the output timeline. A clip
 * carries `clipSound` only when its shot asks for it and its file has sound.
 * A reversed or re-timed clip, or footage another shot re-cuts (intercut),
 * plays silent: its sound would not line up with the picture.
 */
export function clipSoundVoices(plan) {
  return (plan || []).flatMap(({ c, startSec, endSec }) => {
    if (!c?.clipSound || !c.videoPath || c.intercutOf || c.reverse || (c.rate && c.rate !== 1)) return [];
    const start = startSec + (c.leadSec || 0);
    const durationSec = endSec - start;
    if (!(durationSec > 0)) return [];
    return [clipSoundVoice({
      sceneId: c.sceneId, assetPath: c.videoPath, offsetSec: c.inSec || 0, startSec: start, durationSec, clipSound: c.clipSound,
    })];
  });
}

/**
 * The timeline's audio layers (`soundBed.layers`, audioLayers.js) on song time,
 * each cut at the song's end; a layer starting at or after it drops out.
 */
export function songAudioLayerBeds(layers, durationSec) {
  return (layers || []).flatMap((layer) => {
    const length = durationSec != null ? Math.min(layer.durationSec, durationSec - layer.startSec) : layer.durationSec;
    return length > 0 ? [{ ...layer, durationSec: length }] : [];
  });
}

/**
 * The master (`mainLabel`) mixed with the bed, the timeline's audio layers and
 * the clip sounds into `outLabel`, or null when there is nothing to mix (the
 * master plays as is). `durationSec` bounds the bed and the layers to the song.
 */
export function buildSongAudioMix({ mainLabel, soundBed = null, voices = [], firstInputIdx, durationSec, outLabel }) {
  const layers = songAudioLayerBeds(soundBed?.layers, durationSec);
  if (!soundBed?.path && !layers.length && !voices.length) return null;
  const ducks = voices.filter((v) => v.musicLevel < 1)
    .map((v) => `volume=enable='between(t,${fmtSec(v.startSec)},${fmtSec(v.startSec + v.durationSec)})':volume=${fmtSec(v.musicLevel)}`);
  const filters = [`${mainLabel}${[AUDIO_NORM, ...ducks].join(',')}[master]`];
  const beds = [
    ...(soundBed?.path ? [{ assetPath: soundBed.path, offsetSec: 0, durationSec, volume: soundBed.volume }] : []),
    ...layers,
    ...voices,
  ];
  const bed = buildAudioBedMix({ beds, firstInputIdx, mainLabel: '[master]', outLabel, limitPeak: true });
  return { inputs: bed.inputs, filters: [...filters, ...bed.filters] };
}
