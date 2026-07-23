import { useEffect, useState } from 'react';
import { Package, Rocket, RefreshCw } from 'lucide-react';
import {
  compileSpriteAtlas, setSpritePublishBinding, publishSpriteAtlas,
} from '../../services/apiSprites.js';
import { getApps } from '../../services/apiApps.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { spriteAssetUrl } from './spriteAssets.js';
import { timeAgo } from '../../utils/formatters.js';

// Publish workflow (issue #2898): compile the immutable runtime atlas from
// the finalized walk set, bind a managed app + repo-relative destination,
// and publish (atomic replace, divergence-refusing) into the game repo.
// Appears only once the walk set is finalized — the compile input.

function Field({ label, children }) {
  return (
    <label className="block text-xs text-gray-400">
      <span className="block mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputClass = 'w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-200 focus:border-port-accent focus:outline-none';

export default function PublishWorkflow({ record, walk, atlas, onChanged }) {
  const finalized = Boolean(walk?.walkSet);
  const current = atlas?.current || null;
  const publications = atlas?.publications || [];
  const saved = record.publishBinding || null;

  const [apps, setApps] = useState([]);
  const [appId, setAppId] = useState(saved?.appId || '');
  const [destPath, setDestPath] = useState(saved?.atlasDestPath || '');
  const [codePath, setCodePath] = useState(saved?.codeBinding?.path || '');
  const [resourcePath, setResourcePath] = useState(saved?.codeBinding?.resourcePath || '');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!finalized) return;
    getApps({ silent: true })
      .then((list) => setApps((Array.isArray(list) ? list : []).filter((a) => !a.archived)))
      .catch(() => {});
  }, [finalized]);

  // Re-seed the form when the server-side binding changes (save round-trip).
  useEffect(() => {
    setAppId(saved?.appId || '');
    setDestPath(saved?.atlasDestPath || '');
    setCodePath(saved?.codeBinding?.path || '');
    setResourcePath(saved?.codeBinding?.resourcePath || '');
  }, [saved?.appId, saved?.atlasDestPath, saved?.codeBinding?.path, saved?.codeBinding?.resourcePath]);

  const [compile, compiling] = useAsyncAction(async () => {
    const result = await compileSpriteAtlas(record.id, {}, { silent: true });
    onChanged?.();
    return result;
  }, { errorMessage: 'Atlas compile failed' });

  const [saveBinding, savingBinding] = useAsyncAction(async () => {
    const binding = appId && destPath
      ? {
        appId,
        atlasDestPath: destPath.trim(),
        codeBinding: codePath.trim() && resourcePath.trim()
          ? { path: codePath.trim(), resourcePath: resourcePath.trim() }
          : null,
      }
      : null;
    const result = await setSpritePublishBinding(record.id, binding, { silent: true });
    onChanged?.();
    return result;
  }, { errorMessage: 'Could not save the publish binding' });

  const [publish, publishing] = useAsyncAction(async () => {
    setConfirming(false);
    const result = await publishSpriteAtlas(record.id, { silent: true });
    onChanged?.();
    return result;
  }, { errorMessage: 'Publish failed' });

  if (!finalized) return null;

  const bindingDirty = (saved?.appId || '') !== appId
    || (saved?.atlasDestPath || '') !== destPath.trim()
    || (saved?.codeBinding?.path || '') !== codePath.trim()
    || (saved?.codeBinding?.resourcePath || '') !== resourcePath.trim();
  // Publish reads the SAVED binding server-side — gate on it, and hold while
  // a binding save is in flight so a click can't race the PUT.
  const canPublish = Boolean(saved?.appId && saved?.atlasDestPath) && !bindingDirty && !savingBinding && !publishing;
  const boundApp = apps.find((a) => a.id === saved?.appId);

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2">
          <Package size={16} className="text-port-accent" /> Runtime Atlas
        </h3>
        <span className="text-[10px] px-2 py-0.5 rounded bg-port-bg border border-port-border text-gray-400">
          {current ? `v${current.version} · ${timeAgo(current.compiledAt)}` : 'not compiled'}
        </span>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="space-y-2">
          {current && (
            <img
              src={spriteAssetUrl(record.id, current.atlasPath)}
              alt="compiled runtime atlas"
              className="w-full sm:w-60 object-contain bg-port-bg border border-port-border rounded"
              style={{ imageRendering: 'pixelated' }}
            />
          )}
          <button
            onClick={compile}
            disabled={compiling}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
          >
            <RefreshCw size={12} className={compiling ? 'animate-spin' : ''} />
            {current ? 'Recompile atlas' : 'Compile atlas'}
          </button>
        </div>

        <div className="flex-1 space-y-2 min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="Managed app">
              <select value={appId} onChange={(e) => setAppId(e.target.value)} className={inputClass}>
                <option value="">— none —</option>
                {apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
              </select>
            </Field>
            <Field label="Atlas destination (repo-relative .png)">
              <input value={destPath} onChange={(e) => setDestPath(e.target.value)} placeholder="assets/sprites/hero/hero-atlas.png" className={inputClass} />
            </Field>
            <Field label="Code binding file (optional)">
              <input value={codePath} onChange={(e) => setCodePath(e.target.value)} placeholder="src/Hero.cs" className={inputClass} />
            </Field>
            <Field label="Resource path in code (optional)">
              <input value={resourcePath} onChange={(e) => setResourcePath(e.target.value)} placeholder="res://assets/sprites/hero/hero-atlas.png" className={inputClass} />
            </Field>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={saveBinding}
              disabled={savingBinding || !bindingDirty}
              className="px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
            >
              {savingBinding ? 'Saving…' : 'Save binding'}
            </button>
            {!confirming ? (
              <button
                onClick={() => setConfirming(true)}
                disabled={!canPublish}
                title={bindingDirty ? 'Save the binding first' : undefined}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-port-accent/20 border border-port-accent rounded text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
              >
                <Rocket size={12} /> Publish to app
              </button>
            ) : (
              <span className="flex items-center gap-2 text-xs text-gray-300">
                Replace <code className="text-port-warning">{saved?.atlasDestPath}</code> in {boundApp?.name || saved?.appId}?
                <button onClick={publish} disabled={publishing} className="px-2 py-0.5 text-xs bg-port-error/20 border border-port-error rounded text-port-error hover:bg-port-error/30 disabled:opacity-50">
                  {publishing ? 'Publishing…' : 'Confirm'}
                </button>
                <button onClick={() => setConfirming(false)} className="px-2 py-0.5 text-xs bg-port-bg border border-port-border rounded text-gray-400 hover:border-port-accent">
                  Cancel
                </button>
              </span>
            )}
          </div>
        </div>
      </div>

      {publications.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-gray-400">Publish history</h4>
          <ul className="space-y-0.5">
            {publications.map((p) => (
              <li key={p.publishedAt} className="text-[11px] text-gray-500 flex items-center gap-2 flex-wrap">
                <span className="text-gray-300">v{p.version}</span>
                <span>→ {p.appName || p.appId}:{p.atlasDestPath}</span>
                {p.codeBinding?.rewritten && <span className="text-port-warning">code binding rewritten</span>}
                <span>{timeAgo(p.publishedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
