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
import SpritePreview from './SpritePreview.jsx';
import { timeAgo } from '../../utils/formatters.js';

// Publish workflow (issue #2898): compile the immutable runtime atlas from
// the finalized walk set, bind a managed app + repo-relative destination,
// and publish (atomic replace, divergence-refusing) into the game repo.
// Appears only once the walk set is finalized — the compile input.

const inputClass = 'w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-200 focus:border-port-accent focus:outline-none';
const fieldLabelClass = 'block text-xs text-gray-400 mb-1';

// Mirrors of the server contract (server/services/sprites/walkBounds.js is the
// single source of truth; kept as literals here rather than importing a server
// module into the client bundle). WALK_MIN/MAX bound the walk-frame-count
// input; IDLE/SCANNER name the non-walk columns so the "Match current atlas"
// fallback can count walk columns the same way resolveWalkFrameCount does.
const WALK_MIN_FRAME_COUNT = 6;
const WALK_MAX_FRAME_COUNT = 16;
const ATLAS_IDLE_COLUMN = 'idle';
const ATLAS_SCANNER_COLUMN = 'scanner';

// The compiled atlas stamps geometry.walkFrameCount, but imported/legacy
// pointers may omit it — fall back to counting the walk columns, matching the
// server's resolveWalkFrameCount so the compare and the fill button agree.
function walkFrameCountOf(geometry) {
  if (Number.isInteger(geometry?.walkFrameCount)) return geometry.walkFrameCount;
  if (!Array.isArray(geometry?.columns)) return null;
  return geometry.columns.filter(
    (c) => c !== ATLAS_IDLE_COLUMN && c !== ATLAS_SCANNER_COLUMN,
  ).length;
}

export default function PublishWorkflow({ record, walk, atlas, onChanged }) {
  const finalized = Boolean(walk?.walkSet);
  const current = atlas?.current || null;
  const publications = atlas?.publications || [];
  const saved = record.publishBinding || null;

  const savedContract = saved?.runtimeContract || null;
  // Contract fields are strings so an empty input is distinguishable from a 0.
  // The stored contract seeds them; walkFrameCount is the anchor field (an
  // empty walk-frame-count means "no contract").
  const seedFrames = savedContract?.walkFrameCount != null ? String(savedContract.walkFrameCount) : '';
  const seedCell = savedContract?.cellSize != null ? String(savedContract.cellSize) : '';
  const seedCols = savedContract?.columnCount != null ? String(savedContract.columnCount) : '';

  const apps = useSidebarApps();
  const [appId, setAppId] = useState(saved?.appId || '');
  const [destPath, setDestPath] = useState(saved?.atlasDestPath || '');
  const [codePath, setCodePath] = useState(saved?.codeBinding?.path || '');
  const [resourcePath, setResourcePath] = useState(saved?.codeBinding?.resourcePath || '');
  const [contractFrames, setContractFrames] = useState(seedFrames);
  const [contractCell, setContractCell] = useState(seedCell);
  const [contractCols, setContractCols] = useState(seedCols);
  // null → idle; 'publish' → normal confirm; 'overwrite' → the server
  // refused with PUBLISH_DEST_OCCUPIED / PUBLISH_LAYOUT_OCCUPIED and needs
  // explicit consent. occupiedFile names which file the consent is about, so
  // the question doesn't say "atlas" when the blocker is the layout sidecar.
  const [confirmStage, setConfirmStage] = useState(null);
  const [occupiedFile, setOccupiedFile] = useState('atlas');

  // Re-seed the form when the server-side binding changes (save round-trip)
  // — and drop any pending confirmation: consent given for one destination
  // must never carry over to a different binding.
  useEffect(() => {
    setAppId(saved?.appId || '');
    setDestPath(saved?.atlasDestPath || '');
    setCodePath(saved?.codeBinding?.path || '');
    setResourcePath(saved?.codeBinding?.resourcePath || '');
    setContractFrames(seedFrames);
    setContractCell(seedCell);
    setContractCols(seedCols);
    setConfirmStage(null);
  }, [saved?.appId, saved?.atlasDestPath, saved?.codeBinding?.path, saved?.codeBinding?.resourcePath,
    savedContract?.walkFrameCount, savedContract?.cellSize, savedContract?.columnCount,
    seedFrames, seedCell, seedCols]);

  // Parse the three contract inputs. walkFrameCount is the anchor: an empty
  // field means "no contract". cellSize/columnCount are optional (empty → null).
  const framesRaw = contractFrames.trim();
  const cellRaw = contractCell.trim();
  const colsRaw = contractCols.trim();
  const framesNum = framesRaw === '' ? null : Number(framesRaw);
  const cellNum = cellRaw === '' ? null : Number(cellRaw);
  const colsNum = colsRaw === '' ? null : Number(colsRaw);
  const hasContract = framesNum !== null;

  // Whether the contract INPUTS were edited (vs. merely seeded from the saved
  // binding). Used both for the dirty check and to scope the no-binding error
  // to a user who actually typed a contract — an untouched seeded contract must
  // not block an unbind (sending `binding: null` clears it server-side anyway).
  const contractFieldsDirty = seedFrames !== framesRaw || seedCell !== cellRaw || seedCols !== colsRaw;

  const intInRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  // Validate only what's populated; walkFrameCount is required whenever any
  // contract field is set (the server rejects a contract without it). A freshly
  // typed contract is also meaningless without an app + destination — the
  // binding it would ride on is null, so the value would be silently discarded.
  let contractError = null;
  if (!hasContract && (cellRaw !== '' || colsRaw !== '')) {
    contractError = 'Walk frame count is required for a runtime contract.';
  } else if (hasContract && !intInRange(framesNum, WALK_MIN_FRAME_COUNT, WALK_MAX_FRAME_COUNT)) {
    contractError = `Walk frame count must be a whole number ${WALK_MIN_FRAME_COUNT}–${WALK_MAX_FRAME_COUNT}.`;
  } else if (cellNum !== null && !intInRange(cellNum, 16, 1024)) {
    contractError = 'Cell size must be a whole number 16–1024.';
  } else if (colsNum !== null && !intInRange(colsNum, 1, 256)) {
    contractError = 'Column count must be a whole number 1–256.';
  } else if (hasContract && contractFieldsDirty && !(appId && destPath.trim())) {
    contractError = 'Bind an app and destination, or clear the contract.';
  }

  // A re-point (appId change) with a populated contract also counts as dirty so
  // the displayed values are sent explicitly against the new app — otherwise the
  // omitted-key path drops them (server inheritance is app-scoped) while the
  // fields still show them.
  const contractDirty = contractFieldsDirty || (hasContract && appId !== (saved?.appId || ''));

  const fillFromAtlas = () => {
    const geometry = current?.geometry;
    if (!geometry) return;
    const frames = walkFrameCountOf(geometry);
    setContractFrames(frames != null ? String(frames) : '');
    setContractCell(Number.isInteger(geometry.cellSize) ? String(geometry.cellSize) : '');
    setContractCols(Array.isArray(geometry.columns) ? String(geometry.columns.length) : '');
  };

  const clearContract = () => {
    setContractFrames('');
    setContractCell('');
    setContractCols('');
  };

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
    // Absent-vs-null: only touch runtimeContract when the contract group is
    // dirty. An OMITTED key inherits the stored contract server-side (see
    // setPublishBinding); an untouched save must not silently drop it. When
    // dirty, a populated walkFrameCount sets it, an emptied one clears it (null).
    if (binding && contractDirty) {
      binding.runtimeContract = hasContract
        ? { walkFrameCount: framesNum, cellSize: cellNum, columnCount: colsNum }
        : null;
    }
    const result = await setSpritePublishBinding(record.id, binding, { silent: true });
    onChanged?.();
    return result;
  }, { errorMessage: 'Could not save the publish binding' });

  // The confirm row stays mounted while the request is in flight (so the
  // "Publishing…" label is actually visible) and clears on completion.
  const [publish, publishing] = useAsyncAction(async (acknowledgeOverwrite) => {
    const body = acknowledgeOverwrite ? { acknowledgeOverwrite: true } : {};
    const result = await publishSpriteAtlas(record.id, body, { silent: true }).catch((err) => {
      // The destination holds an atlas — or a layout sidecar — PortOS never
      // published. Escalate to an explicit overwrite consent instead of
      // toasting a dead end the UI offers no way to act on.
      if (err?.code === 'PUBLISH_DEST_OCCUPIED' || err?.code === 'PUBLISH_LAYOUT_OCCUPIED') {
        setOccupiedFile(err.code === 'PUBLISH_LAYOUT_OCCUPIED' ? 'layout' : 'atlas');
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

  // A direction still packaged by the source pipeline has no per-frame images
  // here, so the server refuses to compile from it (LEGACY_IMPORTED_WALK_SET).
  // Show why instead of offering a button that always fails. Read the
  // server-stamped flag rather than re-deriving the path convention: it is
  // per-direction, so it clears on its own as each direction is re-derived from
  // its imported clip — which is what makes an imported set compilable at all.
  if (walk.walkSet.imported) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-1">
        <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2">
          <Package size={16} className="text-port-accent" /> Runtime Atlas
        </h3>
        <p className="text-xs text-gray-500">
          {walk.walkSet.importedDirections?.length
            ? `${walk.walkSet.importedDirections.join(', ')} ${walk.walkSet.importedDirections.length === 1 ? 'is' : 'are'} still packaged`
            : 'Some directions are still packaged'} by the source pipeline, which kept their
          per-frame images — PortOS cannot compile from those. Reopen each one above and reprocess
          it from its imported clip to re-derive the frames here, then compile. The imported
          runtime atlases remain in the asset library below.
        </p>
      </div>
    );
  }

  const bindingDirty = (saved?.appId || '') !== appId
    || (saved?.atlasDestPath || '') !== destPath.trim()
    || (saved?.codeBinding?.path || '') !== codePath.trim()
    || (saved?.codeBinding?.resourcePath || '') !== resourcePath.trim()
    || contractDirty;
  // Publish reads the SAVED binding server-side — gate on it, and hold while
  // a binding save is in flight so a click can't race the PUT. The confirm
  // row uses bindingSettled (not canPublish) so it stays mounted while the
  // publish itself is in flight, but disappears the moment the binding is
  // edited — consent never carries across a binding change.
  const bindingSettled = Boolean(saved?.appId && saved?.atlasDestPath) && !bindingDirty && !savingBinding;
  const canPublish = bindingSettled && !publishing;
  const boundApp = apps.find((a) => a.id === saved?.appId);
  const destLabel = `${boundApp?.name || saved?.appId}: ${saved?.atlasDestPath}`;

  // Show the SAVED contract next to the compiled atlas geometry so a shape
  // mismatch is visible here, not only in the publish-time 409. Mirrors the
  // fields runtimeContractMismatch compares server-side.
  const atlasGeom = current?.geometry || null;
  const atlasFrames = walkFrameCountOf(atlasGeom);
  const atlasCols = Array.isArray(atlasGeom?.columns) ? atlasGeom.columns.length : null;
  const atlasCell = Number.isInteger(atlasGeom?.cellSize) ? atlasGeom.cellSize : null;
  const atlasSummary = atlasGeom
    ? `${atlasFrames ?? '?'} walk frames · ${atlasCols ?? '?'} cols${atlasCell != null ? ` · ${atlasCell}px` : ''}`
    : null;
  const savedContractMismatch = (() => {
    if (!savedContract || !atlasGeom) return null;
    if (Number.isInteger(savedContract.walkFrameCount) && savedContract.walkFrameCount !== atlasFrames) {
      return `contract expects ${savedContract.walkFrameCount} walk frames, atlas has ${atlasFrames ?? '?'}`;
    }
    if (Number.isInteger(savedContract.columnCount) && savedContract.columnCount !== atlasCols) {
      return `contract expects ${savedContract.columnCount} cols, atlas has ${atlasCols ?? '?'}`;
    }
    if (Number.isInteger(savedContract.cellSize) && savedContract.cellSize !== atlasCell) {
      return `contract expects ${savedContract.cellSize}px cells, atlas has ${atlasCell ?? '?'}px`;
    }
    return null;
  })();

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
            <SpritePreview
              recordId={record.id}
              path={current.atlasPath}
              alt="compiled runtime atlas"
              className="w-full sm:w-60 border border-port-border rounded"
              imgClassName="w-full object-contain"
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

          <div className="border border-port-border rounded p-2 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs text-gray-300">Runtime contract (optional)</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={fillFromAtlas}
                  disabled={!current}
                  title={current ? undefined : 'Compile the atlas first'}
                  className="px-2 py-0.5 text-[11px] bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
                >
                  Match current atlas
                </button>
                <button
                  type="button"
                  onClick={clearContract}
                  disabled={framesRaw === '' && cellRaw === '' && colsRaw === ''}
                  className="px-2 py-0.5 text-[11px] bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
            </div>
            <p className="text-[11px] text-gray-500">
              The grid a consuming app was built against. A publish whose compiled atlas disagrees is
              refused. Leave blank to publish unchecked; clearing removes a stored contract.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <FormField label={`Walk frames (${WALK_MIN_FRAME_COUNT}–${WALK_MAX_FRAME_COUNT})`} labelClassName={fieldLabelClass}>
                <input
                  type="number"
                  min={WALK_MIN_FRAME_COUNT}
                  max={WALK_MAX_FRAME_COUNT}
                  value={contractFrames}
                  onChange={(e) => setContractFrames(e.target.value)}
                  placeholder="12"
                  className={inputClass}
                />
              </FormField>
              <FormField label="Cell size px (optional)" labelClassName={fieldLabelClass}>
                <input
                  type="number"
                  min={16}
                  max={1024}
                  value={contractCell}
                  onChange={(e) => setContractCell(e.target.value)}
                  placeholder="96"
                  className={inputClass}
                />
              </FormField>
              <FormField label="Column count (optional)" labelClassName={fieldLabelClass}>
                <input
                  type="number"
                  min={1}
                  max={256}
                  value={contractCols}
                  onChange={(e) => setContractCols(e.target.value)}
                  placeholder="13"
                  className={inputClass}
                />
              </FormField>
            </div>
            {contractError && <p className="text-[11px] text-port-error">{contractError}</p>}
            {atlasSummary && (
              <p className="text-[11px] text-gray-500">
                Current atlas grid: <span className="text-gray-300">{atlasSummary}</span>
              </p>
            )}
            {savedContractMismatch && (
              <p className="text-[11px] text-port-warning">Saved contract vs atlas: {savedContractMismatch}</p>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={saveBinding}
              disabled={savingBinding || !bindingDirty || Boolean(contractError)}
              title={contractError || undefined}
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
              question={occupiedFile === 'layout'
                ? `${destLabel} already has a layout sidecar PortOS did not write. Overwrite it?`
                : `${destLabel} already contains an atlas PortOS did not publish. Overwrite it?`}
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
