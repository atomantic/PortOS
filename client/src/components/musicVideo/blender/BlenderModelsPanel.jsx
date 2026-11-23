import { useCallback, useEffect, useState } from 'react';
import { Box, RefreshCw } from 'lucide-react';
import toast from '../../ui/Toast';
import { listImageTo3dModels } from '../../../services/apiImageTo3d.js';
import { listThreejsModels } from '../../../services/apiThreejsModels.js';
import { useFilmApi } from './FilmApiContext.jsx';
import { buttonCls } from './blenderStyles.js';

const asList = (answer) => (Array.isArray(answer) ? answer : Array.isArray(answer?.items) ? answer.items : []);

/**
 * 3D models the film holds under src/models/, plus the picker that copies one in from the
 * image-to-3D and Three.js libraries. A copy is a snapshot: a newer library asset only
 * offers "Update copy", and nothing updates by itself.
 */
export default function BlenderModelsPanel({ projectId, onChanged }) {
  const api = useFilmApi();
  const [models, setModels] = useState([]);
  const [picking, setPicking] = useState(false);
  const [library, setLibrary] = useState({ state: 'idle', items: [] });
  const [busy, setBusy] = useState(null);
  const [snippet, setSnippet] = useState(null);

  const refresh = useCallback(
    () => api.listMusicVideoBlenderModels(projectId, { silent: true }).then((answer) => setModels(answer?.models || [])).catch(() => {}),
    [api, projectId],
  );
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!picking) return undefined;
    let active = true;
    setLibrary({ state: 'loading', items: [] });
    Promise.all([listImageTo3dModels({ silent: true }), listThreejsModels({ silent: true })])
      .then(([meshes, scenes]) => {
        if (!active) return;
        const items = [
          ...asList(meshes).filter((model) => model.status === 'ready').map((model) => ({ kind: 'image-to-3d', id: model.id, name: model.name, detail: model.retarget?.status === 'ready' ? 'animated GLB' : model.rig?.status === 'ready' ? 'rigged GLB' : 'mesh GLB' })),
          ...asList(scenes).filter((model) => model.spec).map((model) => ({ kind: 'threejs', id: model.id, name: model.name, detail: 'Three.js module' })),
        ];
        setLibrary({ state: 'ready', items });
      })
      .catch((error) => { if (active) setLibrary({ state: 'error', items: [], message: error?.message }); });
    return () => { active = false; };
  }, [picking]);

  const run = async (key, call) => {
    setBusy(key);
    try {
      const answer = await call();
      setSnippet(answer.snippet);
      await refresh();
      onChanged?.();
      return true;
    } catch (error) {
      toast.error(error?.message || 'Could not copy the model');
      return false;
    } finally {
      setBusy(null);
    }
  };
  const add = async (item) => {
    if (await run(`${item.kind}:${item.id}`, () => api.addMusicVideoBlenderModel(projectId, { kind: item.kind, id: item.id }, { silent: true }))) setPicking(false);
  };

  return (
    <div className="min-w-0 space-y-1.5" aria-label="3D models">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 text-xs font-medium">3D models</span>
        <button type="button" className={buttonCls} aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
          <Box size={14} aria-hidden="true" /> Add 3D model
        </button>
      </div>
      {picking && (
        <div className="min-w-0 rounded border border-port-border p-1.5">
          {library.state === 'loading' && <p role="status" className="text-xs text-port-text-muted">Loading the 3D library…</p>}
          {library.state === 'error' && <p role="alert" className="text-xs text-port-error">Could not load the library{library.message ? `: ${library.message}` : ''}</p>}
          {library.state === 'ready' && library.items.length === 0 && <p className="text-xs text-port-text-muted">No finished image-to-3D or Three.js models yet.</p>}
          <ul className="max-h-48 divide-y divide-port-border overflow-y-auto">
            {library.items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="flex min-w-0 items-center gap-2 py-1">
                <span className="min-w-0 flex-1 break-words text-xs">{item.name} <span className="text-port-text-muted">· {item.detail}</span></span>
                <button type="button" className={`${buttonCls} shrink-0`} disabled={busy !== null} onClick={() => add(item)}>
                  {busy === `${item.kind}:${item.id}` ? 'Copying…' : 'Add'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {models.length > 0 && (
        <ul aria-label="Models in this film" className="min-w-0 divide-y divide-port-border rounded border border-port-border">
          {models.map((model) => (
            <li key={model.slug} className="flex min-w-0 items-center gap-2 px-2 py-1.5">
              <span className="min-w-0 flex-1 break-all font-mono text-xs">{model.slug}
                {model.sourceMissing && <span className="ml-1 font-sans text-[11px] text-port-warning">source removed</span>}
              </span>
              {model.updateAvailable && (
                <button type="button" className={`${buttonCls} shrink-0`} disabled={busy !== null} onClick={() => run(`update:${model.slug}`, () => api.updateMusicVideoBlenderModel(projectId, model.slug, { silent: true }))}>
                  <RefreshCw size={14} aria-hidden="true" /> {busy === `update:${model.slug}` ? 'Updating…' : 'Update copy'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {snippet && <pre aria-label="Snippet to load the model" className="min-w-0 overflow-x-auto rounded border border-port-border bg-port-bg p-2 font-mono text-[11px]">{snippet}</pre>}
    </div>
  );
}
