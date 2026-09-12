import { useEffect, useMemo, useState } from 'react';
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

// Publish workflow (issue #2898): compile the immutable runtime atlas from the
// record kind's finalized primary animation set, bind a managed app +
// repo-relative destination, and publish (atomic replace,
// divergence-refusing) into the game repo.
// Appears only once that primary set is finalized — the compile input.

const inputClass = 'w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-200 focus:border-port-accent focus:outline-none';
const fieldLabelClass = 'block text-xs text-gray-400 mb-1';
const EMPTY_TRACK_DEFINITIONS = Object.freeze([]);
const DEFAULT_COMPILE_GEOMETRY = Object.freeze({
  cellSize: 96,
  pivot: [48, 88],
  targetMaxHeight: 74,
  targetMaxWidth: 86,
});

export function geometryForCellSize(currentGeometry, requestedCellSize) {
  if (!Number.isInteger(requestedCellSize)) return {};
  const base = Number.isInteger(currentGeometry?.cellSize)
    ? currentGeometry
    : DEFAULT_COMPILE_GEOMETRY;
  const scale = requestedCellSize / base.cellSize;
  const pivot = Array.isArray(base.pivot) && base.pivot.length === 2
    ? base.pivot
    : DEFAULT_COMPILE_GEOMETRY.pivot;
  return {
    cellSize: requestedCellSize,
    pivot: pivot.map((value) => Math.round(value * scale)),
    targetMaxHeight: Math.round(
      (base.targetMaxHeight ?? DEFAULT_COMPILE_GEOMETRY.targetMaxHeight) * scale,
    ),
    targetMaxWidth: Math.round(
      (base.targetMaxWidth ?? DEFAULT_COMPILE_GEOMETRY.targetMaxWidth) * scale,
    ),
  };
}

function contractSeedOf(definitions, contract) {
  return Object.fromEntries(definitions.map((definition) => {
    const value = contract?.[definition.contractFrameCountField];
    return [definition.contractFrameCountField, value == null ? '' : String(value)];
  }));
}

function trackFrameCountOf(geometry, definition) {
  const direct = geometry?.[definition.contractFrameCountField];
  if (Number.isInteger(direct)) return direct;
  const spanCount = geometry?.tracks?.[definition.id]?.count;
  return Number.isInteger(spanCount) ? spanCount : null;
}

export default function PublishWorkflow({
  record, walk, tracks = {}, trackDefinitions = EMPTY_TRACK_DEFINITIONS, atlas, onChanged,
}) {
  const primaryTrack = trackDefinitions.find((definition) => definition.standaloneContract) || null;
  const finalized = Boolean(
    walk?.walkSet
    || Object.values(tracks).some((state) => state?.definition?.standaloneContract && state?.set),
  );
  const current = atlas?.current || null;
  const publications = atlas?.publications || [];
  const saved = record.publishBinding || null;

  const savedContract = saved?.runtimeContract || null;
  // Contract fields are strings so an empty input is distinguishable from a 0.
  // The served registry slice owns every track field, bound, label and primary
  // marker — adding a track needs no corresponding client branch.
  const seedTrackCounts = useMemo(
    () => contractSeedOf(trackDefinitions, savedContract),
    [trackDefinitions, savedContract],
  );
  const seedCell = savedContract?.cellSize != null ? String(savedContract.cellSize) : '';
  const seedCols = savedContract?.columnCount != null ? String(savedContract.columnCount) : '';

  // This picker shows each app's repository path, so retain the full list
  // contract while the Layout/sidebar callers use the lean nav projection.
  const apps = useSidebarApps({ includeDetails: true });
  const [appId, setAppId] = useState(saved?.appId || '');
  const [destPath, setDestPath] = useState(saved?.atlasDestPath || '');
  const [portraitPath, setPortraitPath] = useState(saved?.portraitDestPath || '');
  const [presentationIdlePath, setPresentationIdlePath] = useState(saved?.presentationIdleDestPath || '');
  const [codePath, setCodePath] = useState(saved?.codeBinding?.path || '');
  const [resourcePath, setResourcePath] = useState(saved?.codeBinding?.resourcePath || '');
  const [contractTrackCounts, setContractTrackCounts] = useState(seedTrackCounts);
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
    setPortraitPath(saved?.portraitDestPath || '');
    setPresentationIdlePath(saved?.presentationIdleDestPath || '');
    setCodePath(saved?.codeBinding?.path || '');
    setResourcePath(saved?.codeBinding?.resourcePath || '');
    setContractTrackCounts(seedTrackCounts);
    setContractCell(seedCell);
    setContractCols(seedCols);
    setConfirmStage(null);
  }, [saved?.appId, saved?.atlasDestPath, saved?.portraitDestPath, saved?.presentationIdleDestPath,
    saved?.codeBinding?.path, saved?.codeBinding?.resourcePath,
    seedTrackCounts, seedCell, seedCols]);

  const trackInputs = trackDefinitions.map((definition) => {
    const raw = (contractTrackCounts[definition.contractFrameCountField] || '').trim();
    return {
      definition,
      raw,
      value: raw === '' ? null : Number(raw),
    };
  });
  const cellRaw = contractCell.trim();
  const colsRaw = contractCols.trim();
  const cellNum = cellRaw === '' ? null : Number(cellRaw);
  const colsNum = colsRaw === '' ? null : Number(colsRaw);
  const primaryInput = trackInputs.find(({ definition }) => definition.standaloneContract);
  const hasContract = primaryInput?.value !== null && primaryInput?.value !== undefined;

  // Whether the contract INPUTS were edited (vs. merely seeded from the saved
  // binding). Used both for the dirty check and to scope the no-binding error
  // to a user who actually typed a contract — an untouched seeded contract must
  // not block an unbind (sending `binding: null` clears it server-side anyway).
  const contractFieldsDirty = trackInputs.some(
    ({ definition, raw }) => seedTrackCounts[definition.contractFrameCountField] !== raw,
  ) || seedCell !== cellRaw || seedCols !== colsRaw;

  const intInRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  // Validate only what's populated; a freshly typed contract is meaningless
  // without an app + destination — the
  // binding it would ride on is null, so the value would be silently discarded.
  let contractError = null;
  if (!hasContract && (trackInputs.some(({ raw }) => raw !== '') || cellRaw !== '' || colsRaw !== '')) {
    contractError = `${primaryTrack?.label || 'Primary track'} frame count is required for a runtime contract.`;
  } else {
    const invalidTrack = trackInputs.find(({ definition, value }) => (
      value !== null && !intInRange(value, definition.minFrameCount, definition.maxFrameCount)
    ));
    if (invalidTrack) {
      const { definition } = invalidTrack;
      contractError = `${definition.label} frame count must be a whole number ${definition.minFrameCount}–${definition.maxFrameCount}.`;
    }
  }
  if (!contractError && cellNum !== null && !intInRange(cellNum, 16, 1024)) {
    contractError = 'Cell size must be a whole number 16–1024.';
  } else if (!contractError && colsNum !== null && !intInRange(colsNum, 1, 256)) {
    contractError = 'Column count must be a whole number 1–256.';
  } else if (!contractError && hasContract && contractFieldsDirty && !(appId && destPath.trim())) {
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
    setContractTrackCounts(Object.fromEntries(trackDefinitions.map((definition) => {
      const frames = trackFrameCountOf(geometry, definition);
      return [definition.contractFrameCountField, frames == null ? '' : String(frames)];
    })));
    setContractCell(Number.isInteger(geometry.cellSize) ? String(geometry.cellSize) : '');
    setContractCols(Array.isArray(geometry.columns) ? String(geometry.columns.length) : '');
  };

  const clearContract = () => {
    setContractTrackCounts(contractSeedOf(trackDefinitions, null));
    setContractCell('');
    setContractCols('');
  };

  const [compile, compiling] = useAsyncAction(async () => {
    const geometry = geometryForCellSize(current?.geometry, cellNum);
    const result = await compileSpriteAtlas(record.id, { geometry }, { silent: true });
    onChanged?.();
    return result;
  }, { errorMessage: 'Atlas compile failed' });

  const [saveBinding, savingBinding] = useAsyncAction(async () => {
    const binding = appId && destPath.trim()
      ? {
        appId,
        atlasDestPath: destPath.trim(),
        portraitDestPath: portraitPath.trim() || null,
        presentationIdleDestPath: presentationIdlePath.trim() || null,
        codeBinding: codePath.trim() && resourcePath.trim()
          ? { path: codePath.trim(), resourcePath: resourcePath.trim() }
          : null,
      }
      : null;
    // Absent-vs-null: only touch runtimeContract when the contract group is
    // dirty. An OMITTED key inherits the stored contract server-side (see
    // setPublishBinding); an untouched save must not silently drop it. When
    // dirty, a populated track frame count sets it, an emptied group clears it (null).
    if (binding && contractDirty) {
      binding.runtimeContract = hasContract
        ? {
          ...Object.fromEntries(trackInputs
            .filter(({ value }) => value !== null)
            .map(({ definition, value }) => [definition.contractFrameCountField, value])),
          cellSize: cellNum,
          columnCount: colsNum,
        }
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
      if ([
        'PUBLISH_DEST_OCCUPIED',
        'PUBLISH_LAYOUT_OCCUPIED',
        'PUBLISH_PORTRAIT_OCCUPIED',
        'PUBLISH_PRESENTATION_IDLE_OCCUPIED',
        'PUBLISH_PRESENTATION_IDLE_LAYOUT_OCCUPIED',
      ].includes(err?.code)) {
        setOccupiedFile(err.code === 'PUBLISH_LAYOUT_OCCUPIED'
          ? 'layout'
          : err.code === 'PUBLISH_PORTRAIT_OCCUPIED'
            ? 'portrait'
            : err.code === 'PUBLISH_PRESENTATION_IDLE_OCCUPIED'
              ? 'picker animation'
              : err.code === 'PUBLISH_PRESENTATION_IDLE_LAYOUT_OCCUPIED'
                ? 'picker animation layout'
                : 'atlas');
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
        ? `Atlas v${result.publication.version}${result.portraitWritten ? ', portrait' : ''}${result.presentationIdleWritten ? ', and picker animation' : ''} published${rewriteNote}`
        : `Destination${result.portraitWritten || result.presentationIdleWritten ? ' atlas already current; presentation art published' : ' already up to date'}${rewriteNote}`);
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
  if (walk?.walkSet?.imported) {
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
    || (saved?.portraitDestPath || '') !== portraitPath.trim()
    || (saved?.presentationIdleDestPath || '') !== presentationIdlePath.trim()
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
  const atlasTrackCounts = trackDefinitions.map((definition) => ({
    definition,
    count: trackFrameCountOf(atlasGeom, definition),
  }));
  const atlasCols = Array.isArray(atlasGeom?.columns) ? atlasGeom.columns.length : null;
  const atlasCell = Number.isInteger(atlasGeom?.cellSize) ? atlasGeom.cellSize : null;
  const atlasSummary = atlasGeom
    ? [
      ...atlasTrackCounts
        .filter(({ count }) => count !== null)
        .map(({ definition, count }) => `${count} ${definition.label.toLowerCase()} frames`),
      `${atlasCols ?? '?'} cols`,
      ...(atlasCell == null ? [] : [`${atlasCell}px`]),
    ].join(' · ')
    : null;
  const savedContractMismatch = (() => {
    if (!savedContract || !atlasGeom) return null;
    const trackMismatch = atlasTrackCounts.find(({ definition, count }) => {
      const expected = savedContract[definition.contractFrameCountField];
      return Number.isInteger(expected) && expected !== count;
    });
    if (trackMismatch) {
      const { definition, count } = trackMismatch;
      return `contract expects ${savedContract[definition.contractFrameCountField]} ${definition.label.toLowerCase()} frames, atlas has ${count ?? 'none'}`;
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
            disabled={compiling || Boolean(contractError)}
            title={contractError || (cellNum
              ? `Compile source art at ${cellNum}px per cell`
              : 'Compile with the standard source density')}
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
            <FormField label="Selector portrait (optional .png)" labelClassName={fieldLabelClass}>
              <input value={portraitPath} onChange={(e) => setPortraitPath(e.target.value)} placeholder="assets/portraits/hero.png" className={inputClass} />
            </FormField>
            <FormField label="Picker idle strip (optional .png)" labelClassName={fieldLabelClass}>
              <input value={presentationIdlePath} onChange={(e) => setPresentationIdlePath(e.target.value)} placeholder="assets/presentation/hero-idle.png" className={inputClass} />
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
                  disabled={trackInputs.every(({ raw }) => raw === '') && cellRaw === '' && colsRaw === ''}
                  className="px-2 py-0.5 text-[11px] bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
            </div>
            <p className="text-[11px] text-gray-500">
              The grid a consuming app was built against. A publish whose compiled atlas disagrees is
              refused. Cell size also controls compile density: use 192px for a 2× source that the
              game draws into a 96px footprint. Leave blank to use standard density; clearing removes
              a stored contract.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">
              {trackInputs.map(({ definition, raw }) => (
                <FormField
                  key={definition.contractFrameCountField}
                  label={`${definition.label} frames (${definition.minFrameCount}–${definition.maxFrameCount}${definition.standaloneContract ? '' : ', optional'})`}
                  labelClassName={fieldLabelClass}
                >
                  <input
                    type="number"
                    min={definition.minFrameCount}
                    max={definition.maxFrameCount}
                    value={raw}
                    onChange={(e) => setContractTrackCounts((counts) => ({
                      ...counts,
                      [definition.contractFrameCountField]: e.target.value,
                    }))}
                    placeholder={String(definition.defaultFrameCount)}
                    className={inputClass}
                  />
                </FormField>
              ))}
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
                : occupiedFile === 'portrait'
                  ? `The selector portrait destination already contains an image PortOS did not publish. Overwrite it?`
                  : occupiedFile === 'picker animation'
                    ? `The picker animation destination already contains an image PortOS did not publish. Overwrite it?`
                    : occupiedFile === 'picker animation layout'
                      ? `The picker animation layout destination already contains metadata PortOS did not publish. Overwrite it?`
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
                {p.portraitDestPath && <span>portrait: {p.portraitDestPath}</span>}
                {p.presentationIdleDestPath && <span>picker idle: {p.presentationIdleDestPath}</span>}
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
