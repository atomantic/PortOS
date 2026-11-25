import { useState } from 'react';
import { Package, Rocket, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import {
  compileSpriteAtlas, setSpritePublishBinding, publishSpriteAtlas,
} from '../../services/apiSprites.js';
import { useSidebarApps } from '../../hooks/useSidebarApps.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import InlineConfirmRow from '../ui/InlineConfirmRow.jsx';
import SpritePreview from './SpritePreview.jsx';
import { PublishBindingFields, RuntimeContractEditor } from './PublishWorkflowFields.jsx';
import { usePublishBindingDraft } from './usePublishBindingDraft.js';
import { timeAgo } from '../../utils/formatters.js';

// Publish workflow (issue #2898): compile the immutable runtime atlas from the
// record kind's finalized primary animation set, bind a managed app +
// repo-relative destination, and publish (atomic replace,
// divergence-refusing) into the game repo.
// Appears only once that primary set is finalized — the compile input.

const OCCUPIED_TARGETS = new Map([
  ['PUBLISH_DEST_OCCUPIED', (destLabel) => `${destLabel} already contains an atlas PortOS did not publish. Overwrite it?`],
  ['PUBLISH_LAYOUT_OCCUPIED', (destLabel) => `${destLabel} already has a layout sidecar PortOS did not write. Overwrite it?`],
  ['PUBLISH_PORTRAIT_OCCUPIED', () => 'The selector portrait destination already contains an image PortOS did not publish. Overwrite it?'],
  ['PUBLISH_PRESENTATION_IDLE_OCCUPIED', () => 'The picker animation destination already contains an image PortOS did not publish. Overwrite it?'],
  ['PUBLISH_PRESENTATION_IDLE_LAYOUT_OCCUPIED', () => 'The picker animation layout destination already contains metadata PortOS did not publish. Overwrite it?'],
]);

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

// A direction still packaged by the source pipeline has no per-frame images
// here, so the server refuses to compile from it (LEGACY_IMPORTED_WALK_SET).
// Show why instead of offering a button that always fails. Read the
// server-stamped flag rather than re-deriving the path convention: it is
// per-direction, so it clears on its own as each direction is re-derived from
// its imported clip — which is what makes an imported set compilable at all.
function ImportedAtlasNotice({ walkSet }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-1">
      <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2">
        <Package size={16} className="text-port-accent" /> Runtime Atlas
      </h3>
      <p className="text-xs text-gray-500">
        {walkSet.importedDirections?.length
          ? `${walkSet.importedDirections.join(', ')} ${walkSet.importedDirections.length === 1 ? 'is' : 'are'} still packaged`
          : 'Some directions are still packaged'} by the source pipeline, which kept their
        per-frame images — PortOS cannot compile from those. Reopen each one above and reprocess
        it from its imported clip to re-derive the frames here, then compile. The imported
        runtime atlases remain in the asset library below.
      </p>
    </div>
  );
}

function PublishHistoryList({ publications }) {
  if (!publications.length) return null;
  return (
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
  );
}

export default function PublishWorkflow({
  record, walk, tracks = {}, trackDefinitions = EMPTY_TRACK_DEFINITIONS, atlas, onChanged,
}) {
  const finalized = Boolean(
    walk?.walkSet
    || Object.values(tracks).some((state) => state?.definition?.standaloneContract && state?.set),
  );
  const current = atlas?.current || null;
  const publications = atlas?.publications || [];
  const saved = record.publishBinding || null;

  // The picker displays repository paths from the full sidebar app records.
  const apps = useSidebarApps({ includeDetails: true });
  // null → idle; 'publish' → normal confirm; an occupied code → overwrite confirm.
  const [confirmStage, setConfirmStage] = useState(null);
  const {
    binding, setBindingField, bindingDirty,
    contract, setContractField, setTrackCount, clearContract, fillFromAtlas,
    parsedContract, contractError, contractDirty, savedContract,
  } = usePublishBindingDraft(saved, trackDefinitions, current, setConfirmStage);
  const { trackInputs, cellNum, colsNum, hasContract } = parsedContract;

  const [compile, compiling] = useAsyncAction(async () => {
    const geometry = geometryForCellSize(current?.geometry, cellNum);
    const result = await compileSpriteAtlas(record.id, { geometry }, { silent: true });
    onChanged?.();
    return result;
  }, { errorMessage: 'Atlas compile failed' });

  const [saveBinding, savingBinding] = useAsyncAction(async () => {
    const { appId, atlasDestPath, portraitDestPath, presentationIdleDestPath, codePath, resourcePath } = binding;
    const payload = appId && atlasDestPath.trim()
      ? {
        appId,
        atlasDestPath: atlasDestPath.trim(),
        portraitDestPath: portraitDestPath.trim() || null,
        presentationIdleDestPath: presentationIdleDestPath.trim() || null,
        codeBinding: codePath.trim() && resourcePath.trim()
          ? { path: codePath.trim(), resourcePath: resourcePath.trim() }
          : null,
      }
      : null;
    // Absent-vs-null: only touch runtimeContract when the contract group is
    // dirty. An OMITTED key inherits the stored contract server-side (see
    // setPublishBinding); an untouched save must not silently drop it. When
    // dirty, a populated track frame count sets it, an emptied group clears it (null).
    if (payload && contractDirty) {
      payload.runtimeContract = hasContract
        ? {
          ...Object.fromEntries(trackInputs
            .filter(({ value }) => value !== null)
            .map(({ definition, value }) => [definition.contractFrameCountField, value])),
          cellSize: cellNum,
          columnCount: colsNum,
        }
        : null;
    }
    const result = await setSpritePublishBinding(record.id, payload, { silent: true });
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
      if (OCCUPIED_TARGETS.has(err?.code)) {
        setConfirmStage(err.code);
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

  if (walk?.walkSet?.imported) return <ImportedAtlasNotice walkSet={walk.walkSet} />;

  // Publish reads the SAVED binding server-side — gate on it, and hold while
  // a binding save is in flight so a click can't race the PUT. The confirm
  // row uses bindingSettled (not canPublish) so it stays mounted while the
  // publish itself is in flight, but disappears the moment the binding is
  // edited — consent never carries across a binding change.
  const bindingSettled = Boolean(saved?.appId && saved?.atlasDestPath) && !bindingDirty && !savingBinding;
  const canPublish = bindingSettled && !publishing;
  const overwriteQuestion = OCCUPIED_TARGETS.get(confirmStage);
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
          <PublishBindingFields apps={apps} binding={binding} setBindingField={setBindingField} />

          <RuntimeContractEditor
            current={current}
            trackDefinitions={trackDefinitions}
            savedContract={savedContract}
            contract={contract}
            parsedContract={parsedContract}
            setTrackCount={setTrackCount}
            setContractField={setContractField}
            fillFromAtlas={fillFromAtlas}
            clearContract={clearContract}
            contractError={contractError}
          />

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
          {overwriteQuestion && bindingSettled && (
            <InlineConfirmRow
              question={overwriteQuestion(destLabel)}
              confirmText={publishing ? 'Publishing…' : 'Overwrite'}
              tone="error"
              onConfirm={() => { if (!publishing) publish(true); }}
              onCancel={() => setConfirmStage(null)}
            />
          )}
        </div>
      </div>

      <PublishHistoryList publications={publications} />
    </div>
  );
}
