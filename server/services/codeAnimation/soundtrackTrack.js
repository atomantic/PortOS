/**
 * Resolves a Code Animation job's generated soundtrack onto its `audioUrl`.
 *
 * Kept separate from `soundtrack.js` so export and read paths can resolve a
 * finished track without pulling in music-generation engines (`pipeline/musicGen.js`).
 */

const trackAudioUrl = (track) => `/data/music/${encodeURIComponent(track.audioFilename)}`;
const defaultGetTrack = async (id) => (await import('../tracks/index.js')).getTrack(id);

/** The job with its generated soundtrack (once rendered) as the audio. */
export async function withGeneratedSoundtrack(job, deps = {}) {
  const trackId = job?.soundtrack?.trackId;
  if (!trackId) return job;
  const getTrack = deps.getTrack ?? defaultGetTrack;
  const track = await getTrack(trackId).catch(() => null);
  if (!track?.audioFilename) return job;
  return {
    ...job,
    audioUrl: trackAudioUrl(track),
    input: {
      ...job.input,
      audio: {
        source: 'track',
        trackId: track.id,
        label: track.title || 'Soundtrack',
        durationSeconds: track.durationSec ?? null,
        notes: job.input?.audio?.trackId === track.id ? job.input.audio.notes || '' : '',
      },
      soundtrack: 'none',
    },
  };
}
