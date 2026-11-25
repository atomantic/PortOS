import { ExternalLink, Play, RotateCcw } from 'lucide-react';
import { AUTONOMOUS_CHECKPOINT_LABELS } from '../../../lib/musicVideoAutonomous.js';
import ToggleChip from '../../ui/ToggleChip.jsx';
import SongLinkField from './SongLinkField.jsx';
import { buttonClass, inputClass } from '../controlClasses.js';

export default function CheckpointApprovalBox({ awaiting, editable, draft, missingVideoTools, tools, song, busy, resume }) {
  const changed = editable && draft.value !== editable.value;
  const { value: addTools, setValue: setAddTools } = tools;
  const needsVideoTool = missingVideoTools.length > 0 && !addTools.length;
  const toggleTool = (toolId) => {
    setAddTools(addTools.includes(toolId) ? addTools.filter((id) => id !== toolId) : [...addTools, toolId]);
  };
  const approveCheckpoint = () => {
    const edits = {};
    if (changed) edits[editable.key] = draft.value;
    if (addTools.length) edits.addTools = addTools;
    if (song.overrideRender) edits.sunoSongId = song.pickedRender;
    return resume(edits);
  };

  return (
    <div className="rounded border border-port-border p-2 space-y-2">
      <p className="text-xs text-port-text-muted">
        Paused after <strong className="text-port-text">{AUTONOMOUS_CHECKPOINT_LABELS[awaiting] || awaiting}</strong> — nothing further runs until you approve.
      </p>
      {editable && (
        <div>
          <label htmlFor="mv-auto-edit" className="block text-xs text-port-text-muted mb-1">{editable.label} (edit before continuing)</label>
          <textarea
            id="mv-auto-edit"
            rows={editable.key === 'lyrics' ? 10 : 3}
            value={draft.value}
            onChange={(e) => draft.setValue(e.target.value)}
            className={`${inputClass} font-mono text-xs`}
          />
        </div>
      )}
      {song.renders.length > 0 && (
        <fieldset className="min-w-0" aria-label="Suno render to download">
          <span className="block text-xs text-port-text-muted mb-1">Listen on Suno, then pick the render to download. Approving downloads only that one (it uses one Suno download).</span>
          <div className="flex flex-col gap-1">
            {song.renders.map((id, i) => (
              <label key={id} className="flex items-center gap-2 text-sm min-w-0">
                <input type="radio" name="mv-run-song-pick" checked={song.pickedRender === id} onChange={() => song.pickRender(id)} />
                <span>Render {i + 1}</span>
                <a href={`https://suno.com/song/${id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-port-accent text-xs">
                  Listen <ExternalLink size={12} aria-hidden="true" />
                </a>
              </label>
            ))}
          </div>
          <div className="mt-2"><SongLinkField song={song} /></div>
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        {missingVideoTools.length > 0 && (
          <fieldset className="w-full min-w-0" aria-label="Video tool for the clips">
            <span className="block text-xs text-port-text-muted mb-1">Make the clips with</span>
            <div className="flex flex-wrap gap-1.5">
              {missingVideoTools.map((tool) => (
                <ToggleChip
                  key={tool.id}
                  id={`mv-run-add-${tool.id}`}
                  label={tool.label}
                  checked={addTools.includes(tool.id)}
                  onToggle={() => toggleTool(tool.id)}
                />
              ))}
            </div>
          </fieldset>
        )}
        <button type="button" disabled={busy || needsVideoTool || song.invalidLink} title={needsVideoTool ? 'Choose a video tool to make the clips' : undefined} onClick={approveCheckpoint} className={`${buttonClass} bg-port-accent text-white border-port-accent`}>
          <Play size={14} aria-hidden="true" /> {changed ? 'Save edit & approve' : song.pickedRender ? 'Approve & download this render' : 'Approve & continue'}
        </button>
        {awaiting === 'song' && (
          // Discards this song and makes a new one (a new Suno generation spends credits), then pauses here again.
          <button type="button" disabled={busy} onClick={() => resume({ retakeSong: true })} className={buttonClass}>
            <RotateCcw size={14} aria-hidden="true" /> Retake song
          </button>
        )}
      </div>
    </div>
  );
}
