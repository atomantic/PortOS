import { useState } from 'react';
import toast from '../ui/Toast';
import PhotorealLookSection from './PhotorealLookSection';
import PhotorealCameraList from './PhotorealCameraList';
import PhotorealFlythroughCard from './PhotorealFlythroughCard';
import { PhotorealEngineControls, PhotorealRenderControls } from './PhotorealRenderControls';
import PhotorealSceneStatus, { PhotorealBlenderSetup } from './PhotorealSceneStatus';
import { usePhotorealRenderSettings } from './photorealControls';
import usePhotorealBlender from './usePhotorealBlender';
import usePhotorealStatus from './usePhotorealStatus';
import { saveCatalogGreybox, startCatalogPhotorealRender } from '../../services/apiCatalog';
import { withShot } from '../../lib/greybox';

export default function PhotorealPanel(props) {
  return <PhotorealPanelForRecord key={props.record.id} {...props} />;
}

function PhotorealPanelForRecord(props) {
  const scene = props.record.payload?.greybox;
  const photorealStatus = usePhotorealStatus(props.record.id, props.onRendered);
  if (scene && scene.source !== 'glb') return <PhotorealWorkspace {...props} scene={scene} photorealStatus={photorealStatus} />;
  const { job, cancel, canCancel, canceling } = photorealStatus;

  return (
    <section className="space-y-2" aria-label="Photoreal">
      <h2 className="text-base font-semibold text-white">Photoreal</h2>
      <p className="text-sm text-gray-400">{scene
        ? 'This greybox shows an attached .glb model. Switch its layout source to the saved parts on the Greybox tab to build it in Blender.'
        : 'Save a greybox layout on the Greybox tab first; Blender builds the photoreal scene from it.'}</p>
      {!props.readOnly && job && (
        <PhotorealRenderControls running={job.state === 'running'} job={job} onCancel={cancel} canCancel={canCancel} canceling={canceling} />
      )}
    </section>
  );
}

/**
 * The Photoreal tab of an Environment: build the saved greybox in Blender and
 * render chosen cameras with EEVEE (preview) or Cycles (final). Renders attach as
 * reference images tagged `photoreal:<shotId>`; one can become the camera's photo
 * plate. Progress arrives as `catalog:photoreal` socket frames, never by polling.
 */
function PhotorealWorkspace({ record, scene, media, readOnly = false, disabled = false, onBusyChange, onSaved, photorealStatus }) {
  const shots = scene.shots || [];
  const {
    status, statusRefreshing, statusError, job, reconcile, acceptStarted, acceptOpened, cancel, canCancel, canceling,
  } = photorealStatus;
  const [selected, setSelected] = useState(null);
  const [starting, setStarting] = useState(false);
  const [platingShot, setPlatingShot] = useState('');
  const [lookBusy, setLookBusy] = useState(false);
  const [missingFfmpeg, setMissingFfmpeg] = useState(false);
  const running = job?.state === 'running';
  const sceneBuilding = status?.sceneBuilding === true;
  const changesPending = disabled || lookBusy || !!platingShot;
  const statusUnavailable = !status || statusRefreshing || !!statusError;
  const { engine, engineNote, samplesField, flySeconds, pickEngine, updateFlySeconds } = usePhotorealRenderSettings();
  const blender = usePhotorealBlender(record.id, engine, acceptOpened);
  const { opening, blenderReady, engineReady, noGpuNotice } = blender;
  const canEditScene = !disabled && !platingShot && !sceneBuilding && !statusUnavailable && !opening;
  const canSetPlate = !readOnly && canEditScene && !lookBusy;
  const canStart = canSetPlate && !starting;
  const canOpen = canStart && blenderReady && (!running || !!status.blendUrl);
  const canRender = canStart && engineReady && !running;
  const openInBlender = () => { if (canOpen) return blender.openInBlender(); };

  // Default to every camera until the user picks; always in list order, which is
  // also the order a fly-through visits them.
  const chosen = shots.filter((s) => selected === null || selected.has(s.id)).map((s) => s.id);
  const toggleShot = (id) => setSelected((cur) => {
    const base = cur === null ? new Set(shots.map((s) => s.id)) : new Set(cur);
    if (base.has(id)) base.delete(id); else base.add(id);
    return base;
  });
  const canRenderStills = canRender && chosen.length > 0;
  const canRenderFlythrough = canRender && chosen.length > 1;

  const render = async (flythroughSeconds) => {
    const flythrough = flythroughSeconds !== undefined;
    if (!(flythrough ? canRenderFlythrough : canRenderStills)) return;
    blender.clearNotice();
    setStarting(true);
    const body = { shotIds: chosen, engine, samples: samplesField.effective, ...(flythrough ? { flythroughSeconds } : {}) };
    const started = await startCatalogPhotorealRender(record.id, body, { silent: true })
      .catch((err) => {
        if (flythrough && err?.code === 'FFMPEG_MISSING') setMissingFfmpeg(true);
        else blender.handleBlenderError(err, 'Could not start the Blender render');
        return null;
      });
    setStarting(false);
    if (started && flythrough) setMissingFfmpeg(false);
    if (started) acceptStarted(started);
  };

  const setPlate = async (shot, mediaKey) => {
    if (!canSetPlate) return;
    setPlatingShot(shot.id);
    onBusyChange?.(true);
    const { plate: _previous, ...rest } = shot;
    const updated = await saveCatalogGreybox(record.id, withShot(scene, mediaKey ? { ...rest, plate: mediaKey } : rest), { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to set the photo plate'); return null; });
    setPlatingShot('');
    onBusyChange?.(false);
    if (updated) onSaved?.(updated);
  };

  return (
    <section className="space-y-4" aria-label="Photoreal">
      <PhotorealSceneStatus status={status} statusRefreshing={statusRefreshing} statusError={statusError}
        readOnly={readOnly} canOpen={canOpen} onOpen={openInBlender} onRetry={reconcile}
        opening={opening} sceneBuilding={sceneBuilding} changesPending={changesPending} running={running} />

      <PhotorealBlenderSetup ingredientId={record.id} starting={starting} canOpen={canOpen} onOpen={openInBlender} blender={blender} />

      <PhotorealLookSection record={record} scene={scene} readOnly={readOnly} disabled={running || !canEditScene}
        onBusyChange={(busy) => { setLookBusy(busy); onBusyChange?.(busy); }} onSaved={onSaved} />

      {shots.length === 0 ? (
        <p className="text-sm text-gray-400">Save a camera on the Greybox tab to render it here.</p>
      ) : (
        <div className="space-y-3">
          <PhotorealEngineControls engine={engine} engineNote={engineNote} running={running} samplesField={samplesField}
            noGpuNotice={noGpuNotice} checkedEngine={blender.checkedEngine} showEngineWarning={engineReady && blender.engineMismatch}
            onEngineChange={pickEngine} onOpenSetup={blender.openSetup} />
          <PhotorealCameraList shots={shots} chosen={chosen} media={media} readOnly={readOnly} running={running}
            canSetPlate={canSetPlate} platingShot={platingShot} onToggle={toggleShot} onSetPlate={setPlate} />
        </div>
      )}
      {!readOnly && (shots.length > 0 || job) && (
        <PhotorealRenderControls canRender={canRenderStills} onRender={shots.length > 0 ? () => render() : undefined} count={chosen.length}
          running={running} starting={starting} job={job} onCancel={cancel} canCancel={canCancel} canceling={canceling} />
      )}
      {!readOnly && shots.length > 1 && (
        <PhotorealFlythroughCard canRender={canRenderFlythrough} running={running} cameraCount={chosen.length}
          missingFfmpeg={missingFfmpeg} platform={blender.platform} flySeconds={flySeconds}
          onSecondsChange={updateFlySeconds} video={job?.video} onRender={render} />
      )}
    </section>
  );
}
