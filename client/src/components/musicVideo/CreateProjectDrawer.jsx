import { Plus } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import YoutubeImportControls from './YoutubeImportControls.jsx';

const MODES = ['director', 'autonomous'];

// "New music video" drawer — name/mode/track, or import fresh audio from
// YouTube into the create form's own import slot.
export default function CreateProjectDrawer({ open, onClose, form, onFormChange, tracks, trackName, youtube, onSubmit }) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New music video"
      subtitle="Choose the audio now or attach it later"
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <label htmlFor="mv-name" className="block text-sm font-medium">New project</label>
        <input
          id="mv-name" value={form.name} onChange={(e) => onFormChange({ name: e.target.value })}
          placeholder="Project name" autoFocus
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
        />
        <label htmlFor="mv-mode" className="block text-xs text-port-text-muted">Mode</label>
        <select id="mv-mode" value={form.mode} onChange={(e) => onFormChange({ mode: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm">
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label htmlFor="mv-track" className="block text-xs text-port-text-muted">Track (optional)</label>
        <select id="mv-track" value={form.trackId} onChange={(e) => onFormChange({ trackId: e.target.value })}
          disabled={youtube.createJob.active}
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm disabled:opacity-50">
          <option value="">— no track —</option>
          {tracks.map((t) => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}
        </select>
        <label htmlFor="mv-yt-create" className="block text-xs text-port-text-muted">…or import audio from YouTube</label>
        <div className="flex gap-1">
          <YoutubeImportControls
            id="mv-yt-create" url={youtube.createUrl} onUrlChange={(e) => youtube.setCreateUrl(e.target.value)}
            job={youtube.createJob} onStart={youtube.startCreate}
          />
        </div>
        {form.trackId && !youtube.createJob.active && (
          <p className="text-xs text-port-text-muted">Track set: {trackName(form.trackId)}</p>
        )}
        <button type="submit" disabled={youtube.createJob.active}
          className="w-full flex items-center justify-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
          <Plus size={16} /> Create
        </button>
      </form>
    </Drawer>
  );
}
