import { useEffect, useState } from 'react';
import { Package, Rocket, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import {
  compileSpriteAtlas, setSpritePublishBinding, publishSpriteAtlas,
} from '../../services/apiSprites.js';
import { useSidebarApps } from '../../hooks/useSidebarApps.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import AppContextPicker from '../AppContextPicker.jsx';
import InlineConfirmRow from '../ui/InlineConfirmRow.jsx';
import { FormField } from '../ui/FormField.jsx';
import { spriteAssetUrl } from './spriteAssets.js';
import { timeAgo } from '../../utils/formatters.js';

// Publish workflow (issue #2898): compile the immutable runtime atlas from
// the finalized walk set, bind a managed app + repo-relative destination,
// and publish (atomic replace, divergence-refusing) into the game repo.
// Appears only once the walk set is finalized — the compile input.

const inputClass = 'w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-200 focus:border-port-accent focus:outline-none';
const fieldLabelClass = 'block text-xs text-gray-400 mb-1';

export default function PublishWorkflow({ record, walk, atlas, onChanged }) {
  const finalized = Boolean(walk?.walkSet);
  const current = atlas?.current || null;
  const publications = atlas?.publications || [];
  const saved = record.publishBinding || null;

  const apps = useSidebarApps();
  const [appId, setAppId] = useState(saved?.appId || '');
  const [destPath, setDestPath] = useState(saved?.atlasDestPath || '');
  const [codePath, setCodePath] = useState(saved?.codeBinding?.path || '');
  const [resourcePath, setResourcePath] = useState(saved?.codeBinding?.resourcePath || '');
  // null → idle; 'publish' → normal confirm; 'overwrite' → the server
  // refused with PUBLISH_DEST_OCCUPIED and needs explicit consent.
  const [confirmStage, setConfirmStage] = useState(null);

  // Re-seed the form when the server-side binding changes (save round-trip)
  // — and drop any pending confirmation: consent given for one destination
  // must never carry over to a different binding.
  useEffect(() => {
    setAppId(saved?.appId || '');
    setDestPath(saved?.atlasDestPath || '');
    setCodePath(saved?.codeBinding?.path || '');
    setResourcePath(saved?.codeBinding?.resourcePath || '');
    setConfirmStage(null);
  }, [saved?.appId, saved?.atlasDestPath, saved?.codeBinding?.path, saved?.codeBinding?.resourcePath]);

  const [compile, compiling] = useAsyncAction(async () => {
    const result = await compileSpriteAtlas(record.id, {}, { silent: true });
    onChanged?.();
    return result;
  }, { errorMessage: 'Atlas compile failed' });

  const [saveBinding, savingBinding] = useAsyncAction(async () => {
    const binding = appId && destPath.trim()
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

  // The confirm row stays mounted while the request is in flight (so the
  // "Publishing…" label is actually visible) and clears on completion.
  const [publish, publishing] = useAsyncAction(async (acknowledgeOverwrite) => {
    const body = acknowledgeOverwrite ? { acknowledgeOverwrite: true } : {};
    const result = await publishSpriteAtlas(record.id, body, { silent: true }).catch((err) => {
      // The destination holds an atlas PortOS never published — escalate to
      // an explicit overwrite consent instead of toasting a dead end.
      if (err?.code === 'PUBLISH_DEST_OCCUPIED') {
        setConfirmStage('overwrite');
        return null;
      }
      setConfirmStage(null);
      throw err;
    });
    if (result) {
      setConfirmStage(null);
      const rewriteNote = result.codeBinding?.rewritten || result.publication?.codeBinding?.rewritten
        ? ' — code binding rewritten to the new resource path'
        : '';
      toast.success(result.published
        ? `Atlas v${result.publication.version} published${rewriteNote}`
        : `Destination already up to date${rewriteNote}`);
      onChanged?.();
    }
    return result;
  }, { errorMessage: 'Publish failed' });

  if (!finalized) return null;

  // Phase-1 imported walk sets carry source-pipeline paths and no packaged
  // frames — the server refuses to recompile them (LEGACY_IMPORTED_WALK_SET).
  // Show why instead of offering a button that always fails.
  if (walk.walkSet.selectionPath?.includes('art-source/sprites/')) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-1">
        <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2">
          <Package size={16} className="text-port-accent" /> Runtime Atlas
        </h3>
        <p className="text-xs text-gray-500">
          This walk set was imported from the source pipeline, which kept its packaged frames —
          PortOS cannot recompile it. The imported runtime atlases remain in the asset library
          below; to compile and publish from PortOS, run the walk workflow on a new character.
        </p>
      </div>
    );
  }

  const bindingDirty = (saved?.appId || '') !== appId
    || (saved?.atlasDestPath || '') !== destPath.trim()
    || (saved?.codeBinding?.path || '') !== codePath.trim()
    || (saved?.codeBinding?.resourcePath || '') !== resourcePath.trim();
  // Publish reads the SAVED binding server-side — gate on it, and hold while
  // a binding save is in flight so a click can't race the PUT. The confirm
  // row uses bindingSettled (not canPublish) so it stays mounted while the
  // publish itself is in flight, but disappears the moment the binding is
  // edited — consent never carries across a binding change.
  const bindingSettled = Boolean(saved?.appId && saved?.atlasDestPath) && !bindingDirty && !savingBinding;
  const canPublish = bindingSettled && !publishing;
  const boundApp = apps.find((a) => a.id === saved?.appId);
  const destLabel = `${boundApp?.name || saved?.appId}: ${saved?.atlasDestPath}`;

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
            <AppContextPicker
              apps={apps}
              value={appId}
              onChange={setAppId}
              label="Managed app"
              placeholder="— none —"
              selectClassName={inputClass}
              className="sm:col-span-2"
            />
            <FormField label="Atlas destination (repo-relative .png)" labelClassName={fieldLabelClass}>
              <input value={destPath} onChange={(e) => setDestPath(e.target.value)} placeholder="assets/sprites/hero/hero-atlas.png" className={inputClass} />
            </FormField>
            <FormField label="Code binding file (optional)" labelClassName={fieldLabelClass}>
              <input value={codePath} onChange={(e) => setCodePath(e.target.value)} placeholder="src/Hero.cs" className={inputClass} />
            </FormField>
            <FormField label="Resource path in code (optional)" labelClassName={fieldLabelClass} className="sm:col-span-2">
              <input value={resourcePath} onChange={(e) => setResourcePath(e.target.value)} placeholder="res://assets/sprites/hero/hero-atlas.png" className={inputClass} />
            </FormField>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={saveBinding}
              disabled={savingBinding || !bindingDirty}
              className="px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
            >
              {savingBinding ? 'Saving…' : 'Save binding'}
            </button>
            {!confirmStage && (
              <button
                onClick={() => setConfirmStage('publish')}
                disabled={!canPublish}
                title={bindingDirty ? 'Save the binding first' : undefined}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-port-accent/20 border border-port-accent rounded text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
              >
                <Rocket size={12} /> Publish to app
              </button>
            )}
          </div>
          {confirmStage === 'publish' && bindingSettled && (
            <InlineConfirmRow
              question={`Replace ${destLabel}?`}
              confirmText={publishing ? 'Publishing…' : 'Publish'}
              tone="warning"
              onConfirm={() => { if (!publishing) publish(false); }}
              onCancel={() => setConfirmStage(null)}
            />
          )}
          {confirmStage === 'overwrite' && bindingSettled && (
            <InlineConfirmRow
              question={`${destLabel} already contains an atlas PortOS did not publish. Overwrite it?`}
              confirmText={publishing ? 'Publishing…' : 'Overwrite'}
              tone="error"
              onConfirm={() => { if (!publishing) publish(true); }}
              onCancel={() => setConfirmStage(null)}
            />
          )}
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
