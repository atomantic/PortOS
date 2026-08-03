import { Music, Download } from 'lucide-react';
import toast from '../ui/Toast';
import MidiVisualization from '../songs/MidiVisualization.jsx';
import { trackAudioUrl } from '../../services/apiTracks.js';
import YoutubeImportControls from './YoutubeImportControls.jsx';

/**
 * The project's audio: pick an existing library track or import fresh audio from
 * YouTube (re-selecting either PATCHes the project's trackId), then preview and
 * download the resolved master file. Relinking is blocked while a render or a
 * MIDI transcription is bound to this project — both already resolved the
 * project's audio at kickoff.
 */
export default function TrackPanel({
  project, tracks, trackName, audioFilename, youtube,
  renderBound, midiBound, onChangeTrack,
}) {
  const blockedMessage = renderBound
    ? 'Wait for the current render to finish before changing the track'
    : midiBound
      ? 'Wait for the MIDI transcription to finish before changing the track'
      : null;
  const audioUrl = audioFilename ? trackAudioUrl(audioFilename) : null;
  const midiFile = project.midiTranscription?.filename;
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-port-text-muted flex items-center gap-1"><Music size={12} /> {trackName(project.trackId)}</span>
        <select value={project.trackId || ''} aria-label="Change track"
          onChange={(e) => e.target.value && onChangeTrack(e.target.value)}
          disabled={youtube.editJob.active || renderBound || midiBound}
          title={blockedMessage || undefined}
          className="bg-port-bg border border-port-border rounded px-1.5 py-1 disabled:opacity-50">
          <option value="">Change track…</option>
          {tracks.map((t) => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}
        </select>
        <YoutubeImportControls
          url={youtube.editUrl} onUrlChange={(e) => youtube.setEditUrl(e.target.value)}
          job={youtube.editJob} disabled={renderBound || midiBound}
          onStart={() => {
            if (blockedMessage) {
              toast.error(blockedMessage);
              return;
            }
            youtube.startEdit(project.id);
          }}
          compact
        />
      </div>
      {/* Preview + download the project's master audio track. Both act on
          the resolved data/music/ file (linked track or uploaded audio). */}
      {audioUrl && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <audio src={audioUrl} controls preload="metadata" className="h-8 max-w-full" aria-label="Preview track audio" />
            <a href={audioUrl} download={audioFilename}
              title="Download the audio track"
              className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs hover:bg-port-border/40">
              <Download size={13} /> Download audio
            </a>
          </div>
          {/* The visualization panel owns the MIDI download button, so no
              separate Download-MIDI anchor here (#2477). Served from the
              music dir (same static route as the master audio) so the
              federated .mid resolves on peers too. */}
          {midiFile && (
            <MidiVisualization
              url={trackAudioUrl(midiFile)}
              filename={midiFile}
              model={project.midiTranscription.model}
            />
          )}
        </div>
      )}
    </>
  );
}
