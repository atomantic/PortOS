import { useState } from 'react';
import { updateMusicVideoProject } from '../../services/apiMusicVideo.js';
import { compositionDraft } from './compositionDraft.js';

/** Authored scene input; execution happens only through the render controls. */
export default function EidoverseVideoPanel({ project, onProject }) {
  const [source, setSource] = useState(() => project.composition?.eidoverseScene
    ? JSON.stringify(project.composition.eidoverseScene, null, 2) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setError('');
    setSaved(false);
    let scene;
    try { scene = JSON.parse(source); } catch { setError('Enter a valid scene JSON object.'); return; }
    if (!scene || typeof scene.inlineScript !== 'string' || !scene.inlineScript.trim()) {
      setError('The scene needs a non-empty inlineScript.'); return;
    }
    setBusy(true);
    await updateMusicVideoProject(project.id, { composition: compositionDraft(project, { eidoverseScene: scene }) }, { silent: true })
      .then((next) => { onProject(next); setSaved(true); })
      .catch((err) => setError(err?.message || 'Could not save the Eidoverse scene.'))
      .finally(() => setBusy(false));
  };
  return (
    <section aria-label="Eidoverse Video" className="min-w-0 space-y-2 border-t border-port-border pt-3">
      <h3 className="text-sm font-medium">Eidoverse Video</h3>
      <p className="text-xs text-port-text-muted">Render an authored 3D scene with the optional Eidoverse Video runtime. The master song supplies the audio. Save the scene, then render a draft in Review &amp; Export before approving production.</p>
      <p className="text-xs text-port-text-muted">Requires Docker and the PortOS Eidoverse render image; setup is documented in docs/EIDOVERSE_VIDEO.md. The runtime is separate AGPL-3.0 software. Rendering uses software WebGPU; long scenes can take time.</p>
      <label htmlFor="mv-eidoverse-scene" className="block text-xs text-port-text-muted">Scene JSON (inlineScript and optional bundled assets)</label>
      <textarea id="mv-eidoverse-scene" value={source} disabled={busy} rows={12}
        onChange={(event) => { setSource(event.target.value); setSaved(false); }}
        placeholder={'{"inlineScript":"... Eidoverse scene code ...","assets":{}}'}
        className="w-full min-w-0 rounded border border-port-border bg-port-bg p-2 font-mono text-xs" />
      <p className="text-xs text-port-text-muted">Song duration, aspect and 24 fps are set by the project. Assets must use bundled eidoverse/assets/ paths. Code runs in a container with network access disabled. Drafts render from song time zero, then trim the requested window to preserve simulation timing.</p>
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {saved && <p role="status" className="text-xs text-port-success">Scene saved. Render a draft to review it with the song.</p>}
      <button type="button" onClick={save} disabled={busy || !source.trim()}
        className="min-h-[44px] rounded border border-port-border bg-port-bg px-3 py-1.5 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save scene'}</button>
    </section>
  );
}
