import { Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { fieldClass, labelClass } from './fieldStyles';
import LoomSceneMedia from './LoomSceneMedia';
import LoomReferenceReview from './LoomReferenceReview';
import { FABLELOOM_CAMERA_MOVEMENTS } from '../../../../server/lib/fableLoomCameraMovements.js';
import { resolveFableLoomProtagonistPresence } from '../../../../server/lib/fableLoomPlayback.js';
import useLoomNodeMutations from './useLoomNodeMutations';
import NodeMetadataFields from './NodeMetadataFields';
import NodeInteractionFields from './NodeInteractionFields';
import NodeVisualCanonSection from './NodeVisualCanonSection';
import NodeTransitionsEditor from './NodeTransitionsEditor';

/**
 * FableLoom scene editor — the side panel for the selected node: title/prose,
 * ending flag + label, the intent-transition list, scene image prompt and
 * image/video previews via the shared local media lanes, a known camera-move
 * selector, a dedicated single-clip video prompt, and the AI branch action.
 *
 * Fields save on blur (silent PATCH, skipped when unchanged; the server
 * returns the full loom, which the parent folds into state). Paths save one
 * row at a time against the transition sub-resources — a row exists on the
 * server the moment it is added, so its id is known here and nothing has to be
 * reconciled back after a save. The AI actions read server-side state, so they
 * gate on in-flight saves per the client save-gating convention.
 */

export default function LoomNodeEditor({
  loom, episode, node, universe, onLoomUpdate, onClearSelection, onMakeStart,
  mediaJobs = {}, onGenerateImage, onGenerateVideo, onAutomateFalVideo, onCancelFalVideo,
  generationDisabled = false, generationDisabledReason = '',
}) {
  const {
    form, setForm, referenceCharacterId, setReferenceCharacterId, pendingSaves, addingPath, del,
    otherNodes, patchNode, saveVisualCanon, updateVisualCanon, saveField, saveTransition,
    applyTransition, removeTransition, addTransition, runBranch, branching, runGenerateImage,
    runGenerateVideo, runAutomateFalVideo, attachGalleryVideo, handleDelete, setScenePresence,
  } = useLoomNodeMutations({
    loom, episode, node, onLoomUpdate, onClearSelection, onGenerateImage, onGenerateVideo,
    onAutomateFalVideo,
  });

  if (!form) return null;
  const aiBlocked = pendingSaves > 0;
  const helperMode = loom.participationMode === 'helper';
  const audienceConnected = !helperMode || form.audienceConnection === 'connected';
  const universeCharacters = Array.isArray(universe?.characters) ? universe.characters : [];
  const canonicalProtagonistId = loom.protagonistCharacterId || '';
  const interactionProtagonistId = form.interactionWindow?.protagonistCharacterId || '';
  const protagonistId = interactionProtagonistId || canonicalProtagonistId;
  const protagonist = universeCharacters.find((character) => character.id === protagonistId) || null;
  const protagonistAppearance = form.visualCanon?.characterAppearances?.find(
    (appearance) => appearance.characterId === protagonistId,
  );
  const linkedUniverseId = universe?.id || loom.universeId || null;
  const recommendedPresence = helperMode && form.playbackMode === 'decision' && form.audienceConnection === 'connected'
    ? 'offscreen'
    : canonicalProtagonistId ? 'onscreen' : null;
  const scenePresence = resolveFableLoomProtagonistPresence({
    ...node,
    playbackMode: form.playbackMode,
    audienceConnection: form.audienceConnection,
    protagonistPresence: form.protagonistPresence,
    interactionWindow: form.interactionWindow,
  }, loom) || recommendedPresence;
  const presenceControlVisible = Boolean(
    canonicalProtagonistId || protagonistId || form.visualCanon?.characterAppearances?.length,
  );

  const updateScenePresence = (value) => setScenePresence(value, recommendedPresence);
  const mediaGenerationDisabled = aiBlocked || generationDisabled;
  const mediaDisabledReason = aiBlocked ? 'Wait for scene changes to save' : generationDisabledReason;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Scene</h3>
          {onMakeStart && (
            <button
              type="button"
              onClick={onMakeStart}
              className="text-xs text-port-accent hover:underline"
            >
              Set as opening
            </button>
          )}
        </div>
        {del.isConfirming(node.id) ? (
          <ConfirmButtonPair
            prompt="Delete scene?"
            onConfirm={() => del.confirmDelete(handleDelete)}
            onCancel={del.cancelDelete}
            largeTouchTargets
          />
        ) : (
          <button
            type="button"
            onClick={() => del.requestDelete(node.id)}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-port-text-muted hover:bg-port-error/10 hover:text-port-error"
            aria-label="Delete scene"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      <NodeMetadataFields
        loom={loom}
        form={form}
        setForm={setForm}
        patchNode={patchNode}
        saveField={saveField}
        helperMode={helperMode}
        audienceConnected={audienceConnected}
        recommendedPresence={recommendedPresence}
        scenePresence={scenePresence}
        presenceControlVisible={presenceControlVisible}
        setScenePresence={updateScenePresence}
      />
      <NodeInteractionFields
        loom={loom}
        node={node}
        universe={universe}
        form={form}
        setForm={setForm}
        patchNode={patchNode}
        universeCharacters={universeCharacters}
        canonicalProtagonistId={canonicalProtagonistId}
        protagonistId={protagonistId}
        protagonist={protagonist}
        protagonistAppearance={protagonistAppearance}
        linkedUniverseId={linkedUniverseId}
        scenePresence={scenePresence}
        setScenePresence={updateScenePresence}
      />

      <LoomReferenceReview episode={episode} node={{ ...node, shot: form.shot, visualCanon: form.visualCanon }} />
      {form.visualCanon && node.image && (
        <label className="flex items-center gap-2 text-xs" htmlFor="loom-node-storyboard-approved">
          <input
            id="loom-node-storyboard-approved"
            aria-label="Approve storyboard image for video"
            type="checkbox"
            checked={form.visualCanon.storyboardImageApproved === true}
            onChange={(event) => updateVisualCanon({ storyboardImageApproved: event.target.checked })}
          />
          Approve the current storyboard image as this shot's video first frame
        </label>
      )}
      <div>
        <span className="mb-1 block text-xs font-medium text-port-text-muted">Scene media</span>
        <LoomSceneMedia
          node={node}
          jobs={mediaJobs}
          onGenerateImage={runGenerateImage}
          onGenerateVideo={runGenerateVideo}
          onAutomateFalVideo={runAutomateFalVideo}
          onAttachVideo={attachGalleryVideo}
          onCancelFalVideo={onCancelFalVideo}
          generationDisabled={mediaGenerationDisabled}
          generationDisabledReason={mediaDisabledReason}
          falDisabled={mediaGenerationDisabled}
          falDisabledReason={mediaDisabledReason}
        />
      </div>

      <NodeVisualCanonSection
        loom={loom}
        node={node}
        universe={universe}
        form={form}
        setForm={setForm}
        patchNode={patchNode}
        saveVisualCanon={saveVisualCanon}
        updateVisualCanon={updateVisualCanon}
        referenceCharacterId={referenceCharacterId}
        setReferenceCharacterId={setReferenceCharacterId}
        otherNodes={otherNodes}
        canonicalProtagonistId={canonicalProtagonistId}
        scenePresence={scenePresence}
      />

      <div>
        <span className="mb-1 block text-xs font-medium text-port-text-muted">Scene image prompt</span>
        <textarea
          rows={2}
          className={fieldClass}
          placeholder="Visual description for the image generator"
          aria-label="Image prompt"
          value={form.imagePrompt}
          onChange={(e) => setForm((p) => ({ ...p, imagePrompt: e.target.value }))}
          onBlur={() => saveField('imagePrompt', form.imagePrompt)}
        />
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-port-text-muted">Scene video prompt</span>
        <div className="space-y-2">
          <label htmlFor="loom-node-camera-movement" className={labelClass}>Camera movement</label>
          <select
            id="loom-node-camera-movement"
            className={fieldClass}
            value={form.cameraMovement}
            onChange={(e) => {
              setForm((p) => ({ ...p, cameraMovement: e.target.value }));
              patchNode({ cameraMovement: e.target.value });
            }}
          >
            <option value="">Choose a movement</option>
            {form.cameraMovement && !FABLELOOM_CAMERA_MOVEMENTS.some((move) => move.value === form.cameraMovement) && (
              <option value={form.cameraMovement}>{form.cameraMovement} (custom)</option>
            )}
            {FABLELOOM_CAMERA_MOVEMENTS.map((move) => (
              <option key={move.value} value={move.value}>{move.label}</option>
            ))}
          </select>
          <textarea
            rows={3}
            className={fieldClass}
            placeholder="One continuous clip: action, camera move, pace, atmosphere, final beat"
            aria-label="Video prompt"
            value={form.videoPrompt}
            onChange={(e) => setForm((p) => ({ ...p, videoPrompt: e.target.value }))}
            onBlur={() => saveField('videoPrompt', form.videoPrompt)}
          />
          <p className="text-xs text-port-text-muted">Falls back to the scene text when no dedicated video prompt is set.</p>
        </div>
      </div>

      <NodeTransitionsEditor
        form={form}
        audienceConnected={audienceConnected}
        otherNodes={otherNodes}
        aiBlocked={aiBlocked}
        addingPath={addingPath}
        runBranch={runBranch}
        branching={branching}
        addTransition={addTransition}
        applyTransition={applyTransition}
        saveTransition={saveTransition}
        removeTransition={removeTransition}
      />

    </div>
  );
}
