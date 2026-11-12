/** The exact context staged for Python; a silent film still has a timeline. */
import { atomicWrite } from '../../lib/fileCore.js';
import { blenderSongFile } from './workspace.js';

export async function getBlenderSong(owner, settings) {
  const song = await owner.song();
  if (song) return { ...song, fps: settings.fps };
  return {
    projectId: owner.id, title: '', durationSec: (await owner.timeline()).durationSec, fps: settings.fps,
    audio: { master: null, vocalStem: null },
    analysis: { bpm: null, beats: [], downbeats: [], sections: [], features: null },
    lyrics: { cues: [], markers: [] },
  };
}

export async function writeBlenderSong(owner, settings) {
  const song = await getBlenderSong(owner, settings);
  await atomicWrite(blenderSongFile(owner), song);
  return song;
}
