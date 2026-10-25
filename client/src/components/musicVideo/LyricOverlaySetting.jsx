import { useState } from 'react';
import { updateMusicVideoProject } from '../../services/apiMusicVideo.js';

/** Rendering preference only: lyric timing and authored text stay independently editable. */
export default function LyricOverlaySetting({ project, onUpdated }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const enabled = project.lyricOverlayEnabled !== false;
  const id = `mv-lyric-overlay-${project.id}`;
  const save = async (next) => {
    setSaving(true);
    setError('');
    try {
      const saved = await updateMusicVideoProject(project.id, { lyricOverlayEnabled: next }, { silent: true });
      onUpdated(saved);
    } catch (err) {
      setError(err?.message || 'Could not save lyric overlay visibility');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-1 rounded border border-port-border p-2">
      <div className="flex min-h-[44px] items-center gap-2">
        <input id={id} type="checkbox" checked={enabled} disabled={saving}
          onChange={(event) => { void save(event.target.checked); }} />
        <label htmlFor={id} className="text-sm">Show automatic lyric overlays</label>
        {saving && <span role="status" className="text-xs text-port-text-muted">Saving…</span>}
      </div>
      <p className="text-xs text-port-text-muted">
        Applies to picture previews and renders. Lyrics and word timing stay available for beat-aligned planning and the timing check below.
        Authored text cues, title cards and text already in footage remain separate.
      </p>
      {project.composition?.mode === 'document' && <p className="text-xs text-port-text-muted">
        Custom or previously imported documents must honor the lyric overlay setting; update their lyric renderer before rendering.
      </p>}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
    </div>
  );
}
