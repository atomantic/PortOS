import { Bot, Clapperboard, Plus } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import YoutubeImportControls from './YoutubeImportControls.jsx';
import AutomationBriefFields from './AutomationBriefFields.jsx';
import MoodBoardReferenceStrip from '../moodBoard/MoodBoardReferenceStrip.jsx';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
const MODES = [
  { id: 'autonomous', label: 'Autopilot', icon: Bot, hint: 'Seed it, pick tools and a budget, let the agent churn' },
  { id: 'director', label: 'Director', icon: Clapperboard, hint: 'Build the scene board by hand' },
];

// "New music video" drawer — automation first: name, audio, universe/board,
// then (autopilot) the tools, guidance and budget the agent works within.
// `universes` is null while the page's name list is still loading.
export default function CreateProjectDrawer({ open, onClose, form, onFormChange, tracks, universes, trackName, youtube, onSubmit, submitting }) {
  const autopilot = form.mode === 'autonomous';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="New music video"
      subtitle={autopilot ? 'Seed it, choose tools and a budget, and let the agent churn' : 'Choose the audio now or attach it later'}
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      <form onSubmit={onSubmit} className="space-y-4">
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

        <div>
          <label htmlFor="mv-name" className="block text-xs text-port-text-muted mb-1">Name</label>
          <input
            id="mv-name" value={form.name} onChange={(e) => onFormChange({ name: e.target.value })}
            placeholder="Project name" autoFocus maxLength={200}
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="min-w-0">
            <label htmlFor="mv-track" className="block text-xs text-port-text-muted mb-1">Track</label>
            <select id="mv-track" value={form.trackId} onChange={(e) => onFormChange({ trackId: e.target.value })}
              disabled={youtube.createJob.active}
              className={`${inputClass} disabled:opacity-50`}>
              <option value="">— attach later —</option>
              {tracks.map((t) => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="mv-universe" className="block text-xs text-port-text-muted mb-1">Universe</label>
            <select id="mv-universe" value={form.universeId} onChange={(e) => onFormChange({ universeId: e.target.value })}
              className={inputClass}>
              <option value="">{universes === null ? 'Loading…' : 'No universe'}</option>
              {(universes || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="mv-yt-create" className="block text-xs text-port-text-muted mb-1">…or import audio from YouTube</label>
          <div className="flex gap-1">
            <YoutubeImportControls
              id="mv-yt-create" url={youtube.createUrl} onUrlChange={(e) => youtube.setCreateUrl(e.target.value)}
              job={youtube.createJob} onStart={youtube.startCreate}
            />
          </div>
          {form.trackId && !youtube.createJob.active && (
            <p className="text-xs text-port-text-muted mt-1">Track set: {trackName(form.trackId)}</p>
          )}
        </div>
        <MoodBoardReferenceStrip
          value={form.moodBoardId}
          onChange={(id) => onFormChange({ moodBoardId: id || '' })}
          newBoardName={form.name.trim()}
        />

        {autopilot && (
          <AutomationBriefFields
            idPrefix="mv-create"
            draft={form.automation}
            onChange={(patch) => onFormChange({ automation: { ...form.automation, ...patch } })}
          />
        )}

        <button type="submit" disabled={youtube.createJob.active || submitting || !form.name.trim()}
          className="w-full flex items-center justify-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
          <Plus size={16} /> {submitting ? 'Creating…' : (autopilot ? 'Create autopilot project' : 'Create')}
        </button>
      </form>
    </Drawer>
  );
}
