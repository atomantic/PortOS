import { Box, Download, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
import ProductionContainment from '../codeAnimation/ProductionContainment';
import { detailTabPath, libraryById } from '../../lib/creativeLibraries';
import { copyToClipboard } from '../../lib/clipboard';
import { photorealActionButton } from './photorealControls';

export default function PhotorealSceneStatus({
  status, statusRefreshing, statusError, readOnly, canOpen, onOpen, onRetry, opening, sceneBuilding, changesPending, running,
}) {
  return (
    <>
      <div className="flex flex-wrap items-start gap-2 justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Photoreal</h2>
          <p className="text-xs text-gray-400">Builds this greybox in Blender, dresses it with the Look, and renders its saved cameras. Renders land here and can become a camera&apos;s photo plate.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!readOnly && (
            <button type="button" onClick={onOpen} disabled={!canOpen} className={photorealActionButton}>
              {(opening || sceneBuilding) ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Box size={16} aria-hidden="true" />}
              {opening && status?.blendUrl ? 'Opening Blender…' : (opening || sceneBuilding) ? 'Building scene…' : 'Open in Blender'}
            </button>
          )}
          {status?.blendUrl && (
            <a href={status.blendUrl} download className={photorealActionButton}>
              <Download size={16} aria-hidden="true" /> Download .blend
            </a>
          )}
        </div>
      </div>
      {status && !status.blendUrl && <p role={sceneBuilding ? 'status' : undefined} className="text-xs text-gray-400">{running
        ? 'The current render is building the Blender scene. Open it when the render finishes.'
        : sceneBuilding ? 'A Blender scene is being built. Open it or render cameras when the build finishes.'
        : 'Open in Blender will first build the scene from the saved greybox and Look without rendering cameras, using Cycles CPU.'}</p>}
      {sceneBuilding && status?.blendUrl && <p role="status" className="text-xs text-gray-400">A Blender scene is being built. Open it or render cameras when the build finishes.</p>}
      {status && <p className="text-xs text-gray-400">The scene reflects the Greybox and Look saved when it was built. Later changes appear after the next camera render.</p>}
      {statusRefreshing && <p role="status" className="text-xs text-gray-400">Checking scene status…</p>}
      {statusError && <div role="alert" className="space-y-2 rounded border border-port-warning p-3 text-sm">
        <p>{statusError}</p>
        <button type="button" className={photorealActionButton} onClick={onRetry} disabled={statusRefreshing}>Retry status</button>
      </div>}
      {changesPending && <p role="status" className="text-xs text-port-warning">Wait for the current changes to finish before opening the scene.</p>}
      {running && status?.blendUrl && !readOnly && <p role="status" className="text-xs text-port-warning">The current render will replace this scene when it finishes. In Blender, use File › Save As before editing to keep your changes.</p>}
      {status?.files && (
        <dl className="space-y-1 text-xs" aria-label="Files">
          {[['Blender scene', status.files.blend], ['Renders', status.files.renders]].map(([label, path]) => (
            <div key={label} className="flex flex-wrap items-center gap-x-2">
              <dt className="text-gray-400">{label}</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-gray-300">{path}</dd>
              <dd><button type="button" className={photorealActionButton} onClick={() => copyToClipboard(path, 'Path copied')}>Copy</button></dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

export function PhotorealBlenderSetup({ ingredientId, blender, starting, canOpen, onOpen }) {
  const { opening, setup: { notice, sceneBuildError, refreshing, refreshKey, openRequest, onExecutionChange } } = blender;

  return (
    <>
      <ProductionContainment inline rendererKind="blender" onExecutionChange={onExecutionChange} refreshKey={refreshKey}
        openRequest={openRequest} locked={starting || opening || refreshing} />
      {notice && <p role="alert" className="rounded border border-port-warning p-3 text-sm text-port-warning">{notice}</p>}
      {sceneBuildError && <div role="alert" className="space-y-2 rounded border border-port-warning p-3 text-sm">
        <p>{sceneBuildError}</p>
        <p>Review the saved Greybox and try again. If the build still fails, open Blender setup and run Check Blender.</p>
        <div className="flex flex-wrap gap-2">
          <Link to={detailTabPath(libraryById('environments'), ingredientId, 'greybox')} className={photorealActionButton}>Review Greybox</Link>
          <button type="button" className={photorealActionButton} onClick={blender.openSetup}>Check Blender setup</button>
          <button type="button" className={photorealActionButton} onClick={onOpen} disabled={!canOpen}>Try building scene again</button>
        </div>
      </div>}
    </>
  );
}
