import { useEffect, useState } from 'react';
import { getMusicVideoMidiPlanning } from '../../services/apiMusicVideo.js';
import { formatDurationSec } from '../../utils/formatters.js';

/**
 * The exact lines shot planning and Cast & Sets quote from the project's MIDI
 * transcription (server songMidiDigest.js), so the director sees what the
 * planning model is told about the music. Refetched when the transcription
 * or the analyzed sections change.
 */
export default function MidiPlanningFacts({ project }) {
  const filename = project.midiTranscription?.filename || '';
  const sectionsKey = JSON.stringify((project.audioAnalysis?.sections || []).map((s) => [s.startSec, s.endSec]));
  const [facts, setFacts] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setFacts(null);
    setError('');
    if (!filename) return undefined;
    getMusicVideoMidiPlanning(project.id, { silent: true })
      .then((res) => { if (active) setFacts(res?.facts || null); })
      .catch((err) => { if (active) setError(err?.message || 'Could not read the transcription'); });
    return () => { active = false; };
  }, [project.id, filename, sectionsKey]);

  if (!filename) return null;
  return (
    <details className="rounded border border-port-border p-2 text-sm">
      <summary className="cursor-pointer text-xs text-port-text-muted">What planning reads from the MIDI</summary>
      {error && <p role="alert" className="mt-2 text-xs text-port-error">{error}</p>}
      {!error && !facts && <p className="mt-2 text-xs text-port-text-muted">The transcription has no readable notes, so planning uses the beat analysis alone.</p>}
      {facts && (
        <div className="mt-2 space-y-2 text-xs break-words">
          <p>{facts.summary}</p>
          {facts.sections.length > 0 && (
            <ol className="space-y-1">
              {facts.sections.map((s) => (
                <li key={s.index}><span className="font-medium">{s.label}</span> {formatDurationSec(s.startSec)}–{formatDurationSec(s.endSec)}: {s.facts}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </details>
  );
}
