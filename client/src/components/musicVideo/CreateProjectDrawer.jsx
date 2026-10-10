import MediaModePicker from './MediaModePicker.jsx';
import CharacterStyleSelect from './CharacterStyleSelect.jsx';
import { Bot, Clapperboard, Plus, Music, Sparkles, FileText, CheckCircle2 } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import YoutubeImportControls from './YoutubeImportControls.jsx';
import AutomationBriefFields from './AutomationBriefFields.jsx';
import MoodBoardReferenceStrip from '../moodBoard/MoodBoardReferenceStrip.jsx';
import { trackSourceLabel } from '../../lib/trackProvenance.js';
import { formatDurationSec } from '../../utils/formatters.js';
import { trackOptionLabels } from '../../utils/trackOptionLabels.js';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
const MODES = [
  { id: 'autonomous', label: 'Autopilot', icon: Bot, hint: 'Seed it, pick tools and a budget, let the agent churn' },
  { id: 'director', label: 'Director', icon: Clapperboard, hint: 'Build the scene board by hand' },
];

/**
 * "New music video" drawer — track-first workflow:
 * 1. Select the music track (or import a Suno song or YouTube audio) — audio source for the video.
 * 2. Lyrics, concept, and style info are automatically read from the chosen track.
 * 3. Name, mode, character style, universe/moodboard, and brief settings.
 */
export default function CreateProjectDrawer({ open, onClose, form, onFormChange, tracks, universes, trackName, youtube, onSubmit, submitting }) {
  const autopilot = form.mode === 'autonomous';
  const optionLabels = trackOptionLabels(tracks || []);
  const selectedTrack = (tracks || []).find((t) => t.id === form.trackId) || null;
  const sourceLabel = trackSourceLabel(selectedTrack);

  const handleTrackChange = (trackId) => {
    const track = (tracks || []).find((t) => t.id === trackId);
    const patch = { trackId };
    if (track) {
      if (!form.name || (tracks || []).some((t) => t.title === form.name)) {
        if (track.title) patch.name = track.title;
      }
    }
    onFormChange(patch);
  };

  const lineCount = selectedTrack?.lyrics
    ? selectedTrack.lyrics.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\[[^\]]*\]$/.test(l)).length
    : 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="New music video"
      subtitle={autopilot ? 'Select your track, choose tools and a budget, and let the agent churn' : 'Select your music track to start creating'}
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {/* 1. Track selection — first element in the creation flow */}
        <div className="space-y-2 bg-port-bg/40 border border-port-border rounded-lg p-3">
          <label htmlFor="mv-track" className="block text-xs font-medium text-port-text">
            Track <span className="text-port-text-muted font-normal">(music audio source)</span>
          </label>
          <select
            id="mv-track"
            value={form.trackId}
            onChange={(e) => handleTrackChange(e.target.value)}
            disabled={youtube.createJob.active}
            className={`${inputClass} disabled:opacity-50`}
          >
            <option value="">— choose from music library —</option>
            {(tracks || []).map((t) => (
              <option key={t.id} value={t.id}>
                {optionLabels.get(t.id)}
              </option>
            ))}
          </select>

          <div>
            <span className="block text-xs text-port-text-muted mb-1">…or import a Suno song or YouTube audio</span>
            <div className="flex gap-1">
              <YoutubeImportControls
                id="mv-yt-create"
                url={youtube.createUrl}
                onUrlChange={(e) => youtube.setCreateUrl(e.target.value)}
                job={youtube.createJob}
                onStart={youtube.startCreate}
              />
            </div>
          </div>

          {form.trackId && !youtube.createJob.active && (
            <div className="mt-2 pt-2 border-t border-port-border/60 text-xs space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-port-text flex items-center gap-1">
                  <Music size={13} className="text-port-accent" /> Track set: {trackName(form.trackId)}
                </span>
                {selectedTrack?.artist && (
                  <span className="text-port-text-muted">by {selectedTrack.artist}</span>
                )}
                {sourceLabel && (
                  <span className="px-1.5 py-0.5 rounded bg-port-border text-port-text-muted text-[10px]">
                    {sourceLabel}
                  </span>
                )}
                {selectedTrack?.durationSec && (
                  <span className="text-port-text-muted">({formatDurationSec(selectedTrack.durationSec)})</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-text-muted">
                {lineCount > 0 ? (
                  <span className="inline-flex items-center gap-1 text-port-success bg-port-success/10 px-1.5 py-0.5 rounded">
                    <CheckCircle2 size={11} /> {lineCount} lyric lines loaded
                  </span>
                ) : (
                  <span className="text-port-text-muted">No lyrics in track</span>
                )}
                {selectedTrack?.concept && (
                  <span className="inline-flex items-center gap-1 text-port-accent bg-port-accent/10 px-1.5 py-0.5 rounded">
                    <FileText size={11} /> Concept loaded
                  </span>
                )}
                {selectedTrack?.prompt && (
                  <span className="inline-flex items-center gap-1 text-port-accent bg-port-accent/10 px-1.5 py-0.5 rounded">
                    <Sparkles size={11} /> Style prompt loaded
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 2. Project Name */}
        <div>
          <MediaModePicker value={form.mediaMode} onChange={(mediaMode) => onFormChange({ mediaMode })} />
          <label htmlFor="mv-name" className="block text-xs text-port-text-muted mb-1">Name</label>
          <input
            id="mv-name"
            value={form.name}
            onChange={(e) => onFormChange({ name: e.target.value })}
            placeholder="Project name"
            maxLength={200}
            className={inputClass}
          />
        </div>

        {/* 3. Mode Selection */}
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Mode">
          {MODES.map(({ id, label, icon: Icon, hint }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={form.mode === id}
              onClick={() => onFormChange({ mode: id })}
              className={`text-left rounded border px-3 py-2 min-h-[44px] ${form.mode === id ? 'border-port-accent bg-port-accent/10' : 'border-port-border'}`}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium"><Icon size={15} /> {label}</span>
              <span className="block text-xs text-port-text-muted">{hint}</span>
            </button>
          ))}
        </div>

        {/* 4. Character style, Universe & Mood Board */}
        <div className="grid grid-cols-1 gap-3">
          <CharacterStyleSelect id="mv-character-style" value={form.characterStyleId} onChange={(characterStyleId) => onFormChange({ characterStyleId })} />
          <div className="min-w-0">
            <label htmlFor="mv-universe" className="block text-xs text-port-text-muted mb-1">Universe</label>
            <select
              id="mv-universe"
              value={form.universeId}
              onChange={(e) => onFormChange({ universeId: e.target.value })}
              className={inputClass}
            >
              <option value="">{universes === null ? 'Loading…' : 'No universe'}</option>
              {(universes || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>

        <MoodBoardReferenceStrip
          storageKey="mv-create"
          value={form.moodBoardId}
          onChange={(id) => onFormChange({ moodBoardId: id || '' })}
          newBoardName={form.name.trim()}
        />

        {/* 5. Autopilot Brief */}
        {autopilot && (
          <AutomationBriefFields
            idPrefix="mv-create"
            draft={form.automation}
            onChange={(patch) => onFormChange({ automation: { ...form.automation, ...patch } })}
          />
        )}

        {/* 6. Submit Button */}
        <button
          type="submit"
          disabled={youtube.createJob.active || submitting || !form.name.trim()}
          className="w-full flex items-center justify-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50"
        >
          <Plus size={16} /> {submitting ? 'Creating…' : (autopilot ? 'Create autopilot project' : 'Create')}
        </button>
      </form>
    </Drawer>
  );
}
