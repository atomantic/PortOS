import { useState } from 'react';
import { Music, Download } from 'lucide-react';
import toast from '../ui/Toast';
import MidiVisualization from '../songs/MidiVisualization.jsx';
import { trackAudioUrl } from '../../services/apiTracks.js';
import YoutubeImportControls from './YoutubeImportControls.jsx';
import VocalStemControl from './VocalStemControl.jsx';
import SoundBedControl from './SoundBedControl.jsx';
import { trackSourceLabel } from '../../lib/trackProvenance.js';
import { trackOptionLabels } from '../../utils/trackOptionLabels.js';

const hasTime = (e) => Number.isFinite(e?.startSec) || Number.isFinite(e?.endSec);

// What a track change would wipe from this project (mirrors the server's
// track-change invalidation in projectsLogic.js). Empty means nothing to lose.
function timedDataLabels(project) {
  const cues = project.lyricCues || [];
  const labels = [];
  if (project.audioAnalysis) labels.push('beat/tempo analysis');
  if (cues.some((c) => c.words?.length) || cues.some(hasTime) || (project.phrases || []).some(hasTime)) {
    labels.push('lyric and phrase timing (including word alignment)');
  }
  if (project.midiTranscription) labels.push('MIDI transcription');
  if (project.vocalStemFilename) labels.push('vocal stem');
  if ((project.scenes || []).some((s) => s.beatAligned)) labels.push('beat-aligned shot timing');
  return labels;
}

/**
 * The project's audio: pick an existing library track or import a Suno song or
 * YouTube audio (re-selecting either PATCHes the project's trackId), then preview and
 * download the resolved master file. Relinking is blocked while a render or a
 * MIDI transcription is bound to this project — both already resolved the
 * project's audio at kickoff. An optional vocal stem (#8977) conditions
 * lip-sync performance shots in place of the mix, and an optional
 * sound-design bed (#8988) mixes under the song only when explicitly chosen.
 */
export default function TrackPanel({
  project, tracks, trackName, audioFilename, youtube,
  renderBound, midiBound, onChangeTrack,
}) {
  // A pending change that would destroy timed data waits for explicit confirm.
  const [pending, setPending] = useState(null);
  const clearLabels = timedDataLabels(project);
  const requestChange = (change) => {
    if (clearLabels.length === 0) return runChange(change, {});
    setPending(change);
  };
  const runChange = (change, opts) => {
    setPending(null);
    if (change.kind === 'youtube') youtube.startEdit(project.id);
    else onChangeTrack(change.trackId, { ...opts, cleared: clearLabels });
  };
  const blockedMessage = renderBound
    ? 'Wait for the current render to finish before changing the track'
    : midiBound
      ? 'Wait for the MIDI transcription to finish before changing the track'
      : null;
  const audioUrl = audioFilename ? trackAudioUrl(audioFilename) : null;
  // Where the linked track's audio came from (e.g. a Suno export, #8967).
  const sourceLabel = trackSourceLabel(tracks.find((t) => t.id === project.trackId));
  const optionLabels = trackOptionLabels(tracks);
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-port-text-muted flex min-w-0 max-w-full items-center gap-1 break-words"><Music size={12} className="shrink-0" /> {trackName(project.trackId)}</span>
        {sourceLabel && (
          <span className="px-1.5 py-0.5 rounded bg-port-border text-port-text-muted text-[10px]" title={`Audio imported from ${sourceLabel}`}>
            {sourceLabel}
          </span>
        )}
        <select value={project.trackId || ''} aria-label="Change track"
          onChange={(e) => e.target.value && requestChange({ kind: 'track', trackId: e.target.value })}
          disabled={youtube.editJob.active || renderBound || midiBound}
          title={blockedMessage || undefined}
          className="bg-port-bg border border-port-border rounded px-1.5 py-1 disabled:opacity-50 min-h-[44px] sm:min-h-0 min-w-0 max-w-full">
          <option value="">Change track…</option>
          {tracks.map((t) => <option key={t.id} value={t.id}>{optionLabels.get(t.id)}</option>)}
        </select>
        <YoutubeImportControls
          url={youtube.editUrl} onUrlChange={(e) => youtube.setEditUrl(e.target.value)}
          job={youtube.editJob} disabled={renderBound || midiBound}
          onStart={() => {
            if (blockedMessage) {
              toast.error(blockedMessage);
              return;
            }
            requestChange({ kind: 'youtube' });
          }}
          compact
        />
      </div>
      {pending && (
        <div role="alertdialog" aria-label="Confirm track change" className="mt-2 rounded border border-port-warning/50 bg-port-warning/10 p-2 text-xs space-y-2">
          <p>
            {pending.kind === 'youtube' ? 'Importing new audio' : 'Changing the track'} will clear: {clearLabels.join(', ')}. Lyric text and scenes are kept. The new song is analyzed and the words re-aligned automatically.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => runChange(pending, {})}
              className="min-h-[44px] sm:min-h-0 px-2 py-1 rounded bg-port-error text-white">
              {pending.kind === 'youtube' ? 'Import audio' : 'Change track'}
            </button>
            {pending.kind === 'track' && (
              <button type="button" onClick={() => runChange(pending, { fork: true })}
                className="min-h-[44px] sm:min-h-0 px-2 py-1 rounded border border-port-border text-port-accent">
                Fork &amp; change track
              </button>
            )}
            <button type="button" onClick={() => setPending(null)}
              className="min-h-[44px] sm:min-h-0 px-2 py-1 rounded border border-port-border">Cancel</button>
          </div>
        </div>
      )}
      {/* Preview + download the project's master audio track. Both act on
          the resolved data/music/ file (linked track or uploaded audio). */}
      {audioUrl && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <audio src={audioUrl} controls preload="metadata" className="h-8 max-w-full" aria-label="Preview track audio" />
            <a href={audioUrl} download={audioFilename}
              title="Download the audio track"
              className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0 hover:bg-port-border/40">
              <Download size={13} /> Download audio
            </a>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The jargon-heavy audio options, kept out of the main Song & lyrics path:
 * the vocal stem, the sound bed and the MIDI transcription preview.
 */
export function AdvancedTrackControls({ project, tracks, renderBound, onProjectUpdated, separation = null }) {
  const midiFile = project.midiTranscription?.filename;
  return (
    <>
      <VocalStemControl
        project={project}
        hasAudio={Boolean(project.trackId || project.uploadedAudioFilename)}
        onUpdated={onProjectUpdated}
        separation={separation}
      />
      {/* #8988: an optional, explicitly chosen bed mixed under the song. */}
      <SoundBedControl key={project.id} project={project} tracks={tracks} disabled={renderBound} onUpdated={onProjectUpdated} />
      {midiFile && (
        <MidiVisualization
          url={trackAudioUrl(midiFile)}
          filename={midiFile}
          model={project.midiTranscription.model}
        />
      )}
    </>
  );
}
