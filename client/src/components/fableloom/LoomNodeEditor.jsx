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

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { GitBranch, Loader2, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { FormField } from '../ui/FormField.jsx';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import {
  addLoomTransition, branchLoomNode, deleteLoomNode, deleteLoomTransition,
  updateLoomNode, updateLoomTransition,
} from '../../services/api';
import { fieldClass, labelClass, sceneFieldClass } from './fieldStyles';
import { isTeleplayFormat } from './loomFormats';
import LoomSceneMedia from './LoomSceneMedia';
import { FABLELOOM_CAMERA_MOVEMENTS } from '../../../../server/lib/fableLoomCameraMovements.js';
import {
  FABLELOOM_HOLD_ROTATION_MODES,
  FABLELOOM_PLAYBACK_MODES,
  FABLELOOM_PROTAGONIST_PRESENCE,
  inspectNodeProductionReadiness,
  resolveFableLoomProtagonistPresence,
} from '../../../../server/lib/fableLoomPlayback.js';
import { FABLELOOM_AUDIENCE_CONNECTION_STATES } from '../../../../server/lib/fableLoomParticipation.js';

const toRow = (t) => ({ ...t, triggersText: (t.triggers || []).join('; ') });
const rowToPatch = ({ targetNodeId, intent, triggersText, description }) => ({
  targetNodeId,
  intent: intent || '',
  triggers: (triggersText || '').split(';').map((s) => s.trim()).filter(Boolean),
  description: description || '',
});

const REQUIRED_IDENTITY_ROLES = ['neutral', 'profile', 'full-body'];

const characterReferenceInfo = (character) => {
  const imageRefs = Array.isArray(character?.imageRefs) ? character.imageRefs.filter(Boolean) : [];
  const sheetRefs = [
    character?.referenceSheetImageRef,
    ...Object.values(character?.referenceSheets || {}),
  ].filter(Boolean);
  const approvedRoles = new Set(
    (Array.isArray(character?.identityPack?.assets) ? character.identityPack.assets : [])
      .filter((asset) => asset?.approved === true)
      .map((asset) => asset.role),
  );
  const missingIdentityRoles = REQUIRED_IDENTITY_ROLES.filter((role) => !approvedRoles.has(role));
  return {
    hasVisualReference: imageRefs.length > 0 || sheetRefs.length > 0 || Boolean(character?.primaryImageRef),
    sheetCount: sheetRefs.length,
    identityPackReady: missingIdentityRoles.length === 0,
    missingIdentityRoles,
  };
};

export default function LoomNodeEditor({
  loom, episode, node, universe, onLoomUpdate, onClearSelection, onMakeStart,
  mediaJobs = {}, onGenerateImage, onGenerateVideo, onOpenFalVideo,
  generationDisabled = false, generationDisabledReason = '',
}) {
  const [form, setForm] = useState(null);
  // In-flight blur-saves; the AI buttons (which read server-side state) stay
  // disabled until every pending save settles.
  const [pendingSaves, setPendingSaves] = useState(0);
  const [addingPath, setAddingPath] = useState(false);
  const del = useConfirmDelete();
  // A teleplay carries its own line breaks, so the editor gives it a taller
  // monospaced field — the same surface prose gets, sized for the format.
  const teleplay = isTeleplayFormat(loom.format);

  // Sync from the record on scene switch ONLY (the parent keys this component
  // by node.id, so this is effectively the mount). Re-syncing on every server
  // echo would clobber typing in a sibling field while a blur-save round-trips.
  // Server-side additions that arrive mid-edit (AI branch) are folded in
  // explicitly where they happen.
  useEffect(() => {
    setForm({
      title: node.title || '',
      prose: node.prose || '',
      imagePrompt: node.imagePrompt || '',
      videoPrompt: node.videoPrompt || '',
      cameraMovement: node.cameraMovement || '',
      visualCanon: node.visualCanon ? {
        ...node.visualCanon,
        characterAppearances: [...(node.visualCanon.characterAppearances || [])],
        objectIds: [...(node.visualCanon.objectIds || [])],
      } : null,
      playbackMode: node.playbackMode || 'decision',
      audienceConnection: node.audienceConnection || 'disconnected',
      protagonistPresence: node.protagonistPresence || null,
      playbackAssets: node.playbackAssets || null,
      interactionWindow: node.interactionWindow || {
        enabled: false,
        protagonistCharacterId: null,
        protagonistPresence: 'offscreen',
        audioTarget: 'host',
        ambientDuckDb: -8,
        holdLoopRotation: 'deterministic',
      },
      isEnding: !!node.isEnding,
      endingLabel: node.endingLabel || '',
      transitions: (node.transitions || []).map(toRow),
    });
  }, [node.id]);

  const otherNodes = useMemo(
    () => episode.nodes.filter((n) => n.id !== node.id),
    [episode.nodes, node.id],
  );

  // Every write from this panel goes through here so the AI gate sees it and a
  // failure surfaces once, in one place.
  const runSave = async (write) => {
    setPendingSaves((n) => n + 1);
    const result = await write().catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    setPendingSaves((n) => n - 1);
    return result;
  };

  const patchNode = async (patch) => {
    const updated = await runSave(() => updateLoomNode(loom.id, episode.id, node.id, patch, { silent: true }));
    if (updated) onLoomUpdate(updated);
    return updated;
  };

  const saveVisualCanon = (next) => {
    setForm((current) => ({ ...current, visualCanon: next }));
    patchNode({ visualCanon: next });
  };

  const updateVisualCanon = (patch) => saveVisualCanon({ ...form.visualCanon, ...patch });

  // Blur-save helper: skip the round-trip when the value matches the record
  // (tabbing through the panel shouldn't rewrite the loom).
  const saveField = (key, value) => {
    if (value === (node[key] || '')) return null;
    return patchNode({ [key]: value });
  };

  // Blur-save for one path. Skipped when the row already matches the record,
  // so tabbing through a path doesn't rewrite the loom.
  const saveTransition = async (row) => {
    const saved = (node.transitions || []).find((t) => t.id === row.id);
    const patch = rowToPatch(row);
    // No record row to compare against means the panel is ahead of the loom in
    // state, NOT that nothing changed — save rather than silently drop the edit.
    if (saved && JSON.stringify(patch) === JSON.stringify(rowToPatch(toRow(saved)))) return;
    const updated = await runSave(
      () => updateLoomTransition(loom.id, episode.id, node.id, row.id, patch, { silent: true }),
    );
    if (updated) onLoomUpdate(updated);
  };

  // The save fires OUTSIDE the setState updater — StrictMode runs updaters
  // twice, so a PATCH inside one double-fires.
  const applyTransition = (index, patch, { save = false } = {}) => {
    const transitions = form.transitions.map((t, i) => (i === index ? { ...t, ...patch } : t));
    setForm((prev) => ({ ...prev, transitions }));
    if (save) saveTransition(transitions[index]);
  };

  const removeTransition = async (row) => {
    setForm((prev) => ({ ...prev, transitions: prev.transitions.filter((t) => t.id !== row.id) }));
    const updated = await runSave(
      () => deleteLoomTransition(loom.id, episode.id, node.id, row.id, { silent: true }),
    );
    // The row went out of the list before the round-trip; put the record back
    // if the delete never landed, rather than leaving a path that only looks gone.
    if (updated) onLoomUpdate(updated);
    else setForm((prev) => ({ ...prev, transitions: (node.transitions || []).map(toRow) }));
  };

  // The row is created server-side first, so it arrives with its id already
  // set and every later edit is a plain PATCH against it.
  const addTransition = async () => {
    const target = otherNodes[0];
    if (!target) {
      toast.error('Add another scene first — a path needs somewhere to go');
      return;
    }
    setAddingPath(true);
    const result = await runSave(
      () => addLoomTransition(loom.id, episode.id, node.id, { targetNodeId: target.id, intent: '' }, { silent: true }),
    );
    setAddingPath(false);
    if (!result?.transition) return;
    setForm((prev) => ({ ...prev, transitions: [...prev.transitions, toRow(result.transition)] }));
    onLoomUpdate(result.loom);
  };

  const [runBranch, branching] = useAsyncAction(async () => {
    const result = await branchLoomNode(loom.id, episode.id, node.id, { branchCount: 2 }, { silent: true });
    onLoomUpdate(result.loom);
    // The AI writes new paths straight onto the record; this panel is keyed by
    // node.id so it never remounts to pick them up.
    const wovenNode = result.loom?.episodes.find((e) => e.id === episode.id)
      ?.nodes.find((n) => n.id === node.id);
    if (wovenNode) {
      setForm((prev) => ({
        ...prev,
        playbackMode: wovenNode.playbackMode || 'decision',
        transitions: (wovenNode.transitions || []).map(toRow),
      }));
    }
    toast.success('New branches woven');
  }, { errorMessage: 'Branching failed' });

  const runGenerateImage = async () => {
    const prompt = form.imagePrompt.trim();
    if (!prompt) {
      toast.error('Write an image prompt first');
      return;
    }
    // Persist the prompt if the blur hasn't already, then queue the render
    // with the fableLoom destination tag — the server-side completion hook
    // files the finished image onto this node even if the page unmounts
    // mid-render.
    await saveField('imagePrompt', prompt);
    await onGenerateImage?.({ ...node, imagePrompt: prompt });
  };

  const runGenerateVideo = async () => {
    const authoredPrompt = form.videoPrompt.trim() || form.prose.trim();
    if (!authoredPrompt) {
      toast.error('Write the scene first');
      return;
    }
    await saveField('videoPrompt', form.videoPrompt);
    await onGenerateVideo?.({
      ...node,
      prose: form.prose,
      videoPrompt: form.videoPrompt,
      cameraMovement: form.cameraMovement,
    });
  };

  const runOpenFalVideo = () => {
    const authoredPrompt = form.videoPrompt.trim() || form.prose.trim();
    if (!authoredPrompt) {
      toast.error('Write the scene first');
      return;
    }
    // Keep window.open under the originating click. The free-tool handoff does
    // not read server state, so persisting an unsaved prompt can finish after
    // the new tab opens without risking a popup blocker.
    onOpenFalVideo?.({
      ...node,
      prose: form.prose,
      videoPrompt: form.videoPrompt,
      cameraMovement: form.cameraMovement,
    });
    void saveField('videoPrompt', form.videoPrompt);
  };

  const attachGalleryVideo = async (_targetNode, item) => {
    if (!item?.id || !item?.filename) {
      toast.error('The selected video is missing its gallery record');
      return;
    }
    // Scene playback has historically resolved history ids as `${id}.mp4`.
    // fal H3 Max downloads MP4, so refuse a different gallery container rather
    // than attaching a record whose preview URL this schema cannot represent.
    if (item.filename !== `${item.id}.mp4`) {
      toast.error('Choose an MP4 uploaded here; this gallery video uses a different filename');
      return;
    }
    const updated = await patchNode({ videoHistoryId: item.id });
    if (updated) toast.success('Scene video attached');
  };

  const handleDelete = async () => {
    const updated = await deleteLoomNode(loom.id, episode.id, node.id).catch(() => null);
    if (updated) {
      onLoomUpdate(updated);
      onClearSelection();
    }
  };

  if (!form) return null;
  const aiBlocked = pendingSaves > 0;
  const helperMode = loom.participationMode === 'helper';
  const audienceConnected = !helperMode || form.audienceConnection === 'connected';
  const universeCharacters = Array.isArray(universe?.characters) ? universe.characters : [];
  const canonicalProtagonistId = loom.protagonistCharacterId || '';
  const interactionProtagonistId = form.interactionWindow?.protagonistCharacterId || '';
  const protagonistId = interactionProtagonistId || canonicalProtagonistId;
  const protagonist = universeCharacters.find((character) => character.id === protagonistId) || null;
  const protagonistReference = protagonist ? characterReferenceInfo(protagonist) : null;
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

  const setScenePresence = (value) => {
    const nextPresence = value || null;
    const protagonistIds = new Set([canonicalProtagonistId, interactionProtagonistId, protagonistId].filter(Boolean));
    let nextVisualCanon = form.visualCanon;
    if (form.visualCanon && value === 'offscreen') {
      nextVisualCanon = {
        ...form.visualCanon,
        characterAppearances: form.visualCanon.characterAppearances.filter(
          (appearance) => !protagonistIds.has(appearance.characterId),
        ),
      };
    } else if (form.visualCanon && value === 'onscreen' && canonicalProtagonistId
      && !form.visualCanon.characterAppearances.some((appearance) => appearance.characterId === canonicalProtagonistId)) {
      nextVisualCanon = {
        ...form.visualCanon,
        characterAppearances: [
          ...form.visualCanon.characterAppearances,
          {
            characterId: canonicalProtagonistId,
            wardrobeId: loom.protagonistWardrobeId || null,
            expression: '',
            continuityNotes: '',
          },
        ],
      };
    }
    const nextInteraction = form.interactionWindow?.enabled
      ? {
        ...form.interactionWindow,
        protagonistPresence: value || recommendedPresence || 'offscreen',
      }
      : form.interactionWindow;
    setForm((current) => ({
      ...current,
      protagonistPresence: nextPresence,
      visualCanon: nextVisualCanon,
      interactionWindow: nextInteraction,
    }));
    patchNode({
      protagonistPresence: nextPresence,
      ...(form.interactionWindow?.enabled ? { interactionWindow: nextInteraction } : {}),
      ...(nextVisualCanon !== form.visualCanon ? { visualCanon: nextVisualCanon } : {}),
    });
  };

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

      <FormField label="Title" labelClassName={labelClass}>
        <input
          className={fieldClass}
          value={form.title}
          onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
          onBlur={() => saveField('title', form.title)}
        />
      </FormField>

      <FormField label={teleplay ? 'Scene (teleplay)' : 'Scene prose'} labelClassName={labelClass}>
        <textarea
          rows={teleplay ? 12 : 7}
          className={sceneFieldClass(loom.format)}
          value={form.prose}
          onChange={(e) => setForm((p) => ({ ...p, prose: e.target.value }))}
          onBlur={() => saveField('prose', form.prose)}
        />
      </FormField>

      <FormField label="Playback behavior" labelClassName={labelClass}>
        <select
          className={fieldClass}
          aria-label="Playback behavior"
          value={form.playbackMode}
          onChange={(e) => {
            setForm((p) => ({ ...p, playbackMode: e.target.value }));
            patchNode({ playbackMode: e.target.value });
          }}
        >
          {FABLELOOM_PLAYBACK_MODES.map((mode) => (
            <option key={mode} value={mode} disabled={helperMode && !audienceConnected && mode === 'decision'}>
              {mode === 'cut' ? 'Automatic cut — play once, then advance' : 'Decision point — loop while awaiting input'}
            </option>
          ))}
        </select>
      </FormField>

      {helperMode && (
        <FormField label="Audience connection" labelClassName={labelClass}>
          <select
            className={fieldClass}
            aria-label="Audience connection"
            value={form.audienceConnection}
            onChange={(event) => {
              const audienceConnection = event.target.value;
              const nextPlaybackMode = audienceConnection === 'disconnected' ? 'cut' : form.playbackMode;
              setForm((current) => ({
                ...current,
                audienceConnection,
                playbackMode: nextPlaybackMode,
              }));
              patchNode({ audienceConnection, playbackMode: nextPlaybackMode });
            }}
          >
            {FABLELOOM_AUDIENCE_CONNECTION_STATES.map((state) => (
              <option key={state} value={state}>
                {state === 'connected' ? 'Connected — audience can help' : 'Disconnected — passive canon only'}
              </option>
            ))}
          </select>
          <p className="text-xs text-port-text-muted mt-1">
            {form.audienceConnection === 'connected'
              ? `The protagonist can hear the audience through ${loom.audienceCommunicationMedium || 'the configured medium'}.`
              : 'The audience watches but cannot choose until the communication medium is activated or restored.'}
          </p>
        </FormField>
      )}

      {presenceControlVisible && (
        <div className="rounded border border-port-accent/30 bg-port-accent/5 p-3 space-y-2">
          <FormField label="Visual protagonist presence" labelClassName={labelClass}>
            <select
              className={fieldClass}
              aria-label="Visual protagonist presence"
              value={form.protagonistPresence || ''}
              onChange={(event) => setScenePresence(event.target.value)}
            >
              <option value="">
                Inherit story default{recommendedPresence ? ` (${recommendedPresence === 'offscreen' ? 'off-screen' : 'on-screen'})` : ''}
              </option>
              {FABLELOOM_PROTAGONIST_PRESENCE.map((presence) => (
                <option key={presence} value={presence}>
                  {presence === 'offscreen' ? 'Off-screen — omit protagonist from storyboard' : 'On-screen — include protagonist in storyboard'}
                </option>
              ))}
            </select>
          </FormField>
          {scenePresence === 'offscreen' ? (
            <p className="text-[11px] text-port-accent">
              Side-device conversation: the decision loop stays visible while the protagonist speaks directly with the audience. The protagonist is removed from this scene&apos;s visual cast.
            </p>
          ) : (
            <p className="text-[11px] text-port-text-muted">
              On-screen scenes inherit the loom&apos;s canonical protagonist and locked wardrobe when the shot is bound to Universe canon.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm" htmlFor="loom-node-ending">
          <input
            id="loom-node-ending"
            type="checkbox"
            checked={form.isEnding}
            onChange={(e) => {
              setForm((p) => ({ ...p, isEnding: e.target.checked }));
              patchNode({ isEnding: e.target.checked });
            }}
          />
          This scene is an ending
        </label>
      </div>
      {form.isEnding && (
        <FormField label="Ending name" labelClassName={labelClass}>
          <input
            className={fieldClass}
            placeholder="e.g. Treasure found"
            value={form.endingLabel}
            onChange={(e) => setForm((p) => ({ ...p, endingLabel: e.target.value }))}
            onBlur={() => saveField('endingLabel', form.endingLabel)}
          />
        </FormField>
      )}

      <div>
        <span className="mb-1 block text-xs font-medium text-port-text-muted">Live interaction & voice</span>
        <div className="border border-port-border rounded-lg p-3 bg-port-bg/40 space-y-3">
          <label className="flex items-center gap-2 text-xs font-medium" htmlFor="loom-interaction-enabled">
            <input
              id="loom-interaction-enabled"
              type="checkbox"
              checked={form.interactionWindow?.enabled || false}
              onChange={(e) => {
                const nextInteraction = {
                  ...(form.interactionWindow || {}),
                  enabled: e.target.checked,
                  protagonistCharacterId: form.interactionWindow?.protagonistCharacterId
                    || canonicalProtagonistId
                    || null,
                  protagonistPresence: form.interactionWindow?.protagonistPresence
                    || scenePresence
                    || 'offscreen',
                };
                setForm((p) => ({ ...p, interactionWindow: nextInteraction }));
                patchNode({ interactionWindow: nextInteraction });
              }}
            />
            Live conversation window (off-screen voice)
          </label>

          {form.interactionWindow?.enabled && (
            <div className="space-y-3 pl-5 pt-1 border-l-2 border-port-accent/30 text-xs">
              <FormField label="Protagonist from Universe Bible" labelClassName={labelClass}>
                <select
                  className={fieldClass}
                  id="loom-protagonist-character"
                  aria-label="Protagonist character"
                  value={protagonistId}
                  onChange={(e) => {
                    const next = {
                      ...form.interactionWindow,
                      protagonistCharacterId: e.target.value || null,
                    };
                    setForm((p) => ({ ...p, interactionWindow: next }));
                    patchNode({ interactionWindow: next });
                  }}
                >
                  <option value="">Choose a Universe character</option>
                  {protagonistId && !protagonist && (
                    <option value={protagonistId}>Missing Universe character ({protagonistId})</option>
                  )}
                  {universeCharacters.map((character) => (
                    <option key={character.id} value={character.id}>{character.name || character.id}</option>
                  ))}
                </select>
              </FormField>

              {protagonist ? (
                <div className="rounded border border-port-border/70 bg-port-bg/40 p-2 space-y-1.5" role="status">
                  <div className="font-medium text-port-text">{protagonist.name || protagonist.id}</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                    <span className={protagonistReference.hasVisualReference ? 'text-port-success' : 'text-port-warning'}>
                      {protagonistReference.hasVisualReference ? 'Visual reference ready' : 'Needs visual reference'}
                    </span>
                    <span className={protagonistReference.sheetCount ? 'text-port-success' : 'text-port-warning'}>
                      {protagonistReference.sheetCount
                        ? `${protagonistReference.sheetCount} character sheet${protagonistReference.sheetCount === 1 ? '' : 's'}`
                        : 'Needs character sheet'}
                    </span>
                    <span className={protagonistReference.identityPackReady ? 'text-port-success' : 'text-port-warning'}>
                      {protagonistReference.identityPackReady
                        ? 'Identity pack ready'
                        : `Identity pack missing ${protagonistReference.missingIdentityRoles.join(', ')}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {linkedUniverseId && (
                      <Link
                        to={`/universes/${encodeURIComponent(linkedUniverseId)}?tab=cast`}
                        className="text-[11px] text-port-accent hover:underline"
                      >
                        Open Universe character sheets
                      </Link>
                    )}
                  </div>
                  {scenePresence === 'offscreen' && form.visualCanon && protagonistAppearance && (
                    <p className="text-[11px] text-port-accent">
                      Protagonist binding is omitted from this off-screen storyboard; it will return when this scene is marked on-screen.
                    </p>
                  )}
                  {scenePresence !== 'offscreen' && !protagonistAppearance && form.visualCanon && (
                    <p className="text-[11px] text-port-warning">
                      This scene&apos;s locked image/video cast does not include the protagonist yet.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-port-warning">
                  Select the protagonist from the linked Universe before enabling canon-locked voice or visual production.
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                <FormField label="Protagonist presence" labelClassName={labelClass}>
                  <select
                    className={fieldClass}
                    value={form.interactionWindow.protagonistPresence || scenePresence || 'offscreen'}
                    onChange={(e) => setScenePresence(e.target.value)}
                  >
                    {FABLELOOM_PROTAGONIST_PRESENCE.map((p) => (
                      <option key={p} value={p}>{p === 'offscreen' ? 'Off-screen' : 'On-screen'}</option>
                    ))}
                  </select>
                </FormField>

                <FormField label="Hold rotation" labelClassName={labelClass}>
                  <select
                    className={fieldClass}
                    value={form.interactionWindow.holdLoopRotation || 'deterministic'}
                    onChange={(e) => {
                      const next = { ...form.interactionWindow, holdLoopRotation: e.target.value };
                      setForm((p) => ({ ...p, interactionWindow: next }));
                      patchNode({ interactionWindow: next });
                    }}
                  >
                    {FABLELOOM_HOLD_ROTATION_MODES.map((mode) => (
                      <option key={mode} value={mode}>{mode[0].toUpperCase() + mode.slice(1)}</option>
                    ))}
                  </select>
                </FormField>
              </div>

              <FormField label={`Ambience ducking: ${form.interactionWindow.ambientDuckDb ?? -8} dB`} labelClassName={labelClass}>
                <input
                  type="range"
                  min="-60"
                  max="0"
                  step="1"
                  className="w-full cursor-pointer accent-port-accent"
                  value={form.interactionWindow.ambientDuckDb ?? -8}
                  onChange={(e) => {
                    const next = { ...form.interactionWindow, ambientDuckDb: parseInt(e.target.value, 10) };
                    setForm((p) => ({ ...p, interactionWindow: next }));
                  }}
                  onMouseUp={() => patchNode({ interactionWindow: form.interactionWindow })}
                  onTouchEnd={() => patchNode({ interactionWindow: form.interactionWindow })}
                />
              </FormField>
            </div>
          )}

          {(() => {
            const readiness = inspectNodeProductionReadiness(node, { loom, universe });
            if (!readiness.findings.length) return null;
            return (
              <div className="mt-2 space-y-1.5 pt-2 border-t border-port-border/60">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-port-text-muted">
                  Readiness checks ({readiness.errorCount} error{readiness.errorCount === 1 ? '' : 's'})
                </span>
                {readiness.findings.map((f, i) => (
                  <div
                    key={i}
                    className={`text-xs p-2 rounded border ${
                      f.severity === 'error' ? 'bg-port-error/10 border-port-error/30 text-port-error' :
                      f.severity === 'warning' ? 'bg-port-warning/10 border-port-warning/30 text-port-warning' :
                      'bg-port-bg border-port-border text-port-text-muted'
                    }`}
                  >
                    <p className="font-medium">{f.message}</p>
                    {f.remediation && <p className="text-[11px] opacity-80 mt-0.5">Tip: {f.remediation}</p>}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-port-text-muted">Scene media</span>
        <LoomSceneMedia
          node={node}
          jobs={mediaJobs}
          onGenerateImage={runGenerateImage}
          onGenerateVideo={runGenerateVideo}
          onOpenFalVideo={runOpenFalVideo}
          onAttachVideo={attachGalleryVideo}
          generationDisabled={aiBlocked || generationDisabled}
          generationDisabledReason={aiBlocked ? 'Wait for scene changes to save' : generationDisabledReason}
          falDisabled={generationDisabled}
          falDisabledReason={generationDisabledReason}
        />
      </div>

      <div className="rounded border border-port-border p-3 space-y-3">
        <label className="flex items-center gap-2 text-sm" htmlFor="loom-node-visual-canon">
          <input
            id="loom-node-visual-canon"
            aria-label="Bind this shot to Universe canon"
            type="checkbox"
            checked={Boolean(form.visualCanon)}
            onChange={(event) => saveVisualCanon(event.target.checked ? {
              mode: 'locked', characterAppearances: [], placeId: null, objectIds: [],
              continuitySourceNodeId: null, shotNotes: '', storyboardImageApproved: false,
            } : null)}
          />
          Bind this shot to Universe canon
        </label>
        {form.visualCanon && (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-xs" htmlFor="loom-node-canon-draft">
              <input
                id="loom-node-canon-draft"
                aria-label="Allow degraded canon draft"
                type="checkbox"
                checked={form.visualCanon.mode === 'draft'}
                onChange={(event) => updateVisualCanon({ mode: event.target.checked ? 'draft' : 'locked' })}
              />
              Allow an explicitly degraded draft when this backend cannot preserve canon
            </label>

            <fieldset className="space-y-2">
              <legend className={labelClass}>Characters</legend>
              <p className="text-[11px] text-port-text-muted">
                Bind every on-screen character to the Universe Bible. Canon-locked renders use each selected character&apos;s visual reference, wardrobe, and approved neutral/profile/full-body identity assets.
              </p>
              {canonicalProtagonistId && scenePresence !== 'offscreen'
                && !form.visualCanon.characterAppearances.some((appearance) => appearance.characterId === canonicalProtagonistId) && (
                <button
                  type="button"
                  aria-label="Add canonical protagonist to visual cast"
                  className="text-xs text-port-accent hover:underline"
                  onClick={() => updateVisualCanon({
                    characterAppearances: [
                      ...form.visualCanon.characterAppearances,
                      {
                        characterId: canonicalProtagonistId,
                        wardrobeId: loom.protagonistWardrobeId || null,
                        expression: '',
                        continuityNotes: '',
                      },
                    ],
                  })}
                >
                  Add canonical protagonist to visual cast
                </button>
              )}
              {(universe?.characters || []).map((character) => {
                const appearance = form.visualCanon.characterAppearances
                  .find((item) => item.characterId === character.id);
                const reference = characterReferenceInfo(character);
                const canonicalWardrobeLocked = character.id === canonicalProtagonistId
                  && loom.protagonistWardrobeLocked === true
                  && Boolean(loom.protagonistWardrobeId);
                const wardrobeValue = canonicalWardrobeLocked
                  ? loom.protagonistWardrobeId
                  : appearance?.wardrobeId || '';
                return (
                  <div key={character.id} className="rounded bg-port-bg-subtle p-2 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <label className="flex items-center gap-2 text-xs" htmlFor={`loom-canon-character-${character.id}`}>
                        <input
                          id={`loom-canon-character-${character.id}`}
                          aria-label={character.name}
                          type="checkbox"
                          checked={Boolean(appearance)}
                          onChange={(event) => updateVisualCanon({
                            characterAppearances: event.target.checked
                              ? [...form.visualCanon.characterAppearances, {
                                characterId: character.id,
                                wardrobeId: character.id === canonicalProtagonistId
                                  ? loom.protagonistWardrobeId || null
                                  : null,
                                expression: '',
                                continuityNotes: '',
                              }]
                              : form.visualCanon.characterAppearances.filter((item) => item.characterId !== character.id),
                          })}
                        />
                        {character.name}
                      </label>
                      <span className={`text-[10px] ${reference.identityPackReady ? 'text-port-success' : 'text-port-warning'}`}>
                        {reference.identityPackReady
                          ? 'Identity pack ready'
                          : reference.sheetCount
                            ? `Sheet ready · identity missing ${reference.missingIdentityRoles.join(', ')}`
                            : 'Needs character sheet'}
                      </span>
                    </div>
                    {appearance && (character.wardrobes || []).length > 0 && (
                      <select
                        className={fieldClass}
                        aria-label={`${character.name} wardrobe`}
                        value={wardrobeValue}
                        disabled={canonicalWardrobeLocked}
                        onChange={(event) => updateVisualCanon({
                          characterAppearances: form.visualCanon.characterAppearances.map((item) => (
                            item.characterId === character.id ? { ...item, wardrobeId: event.target.value || null } : item
                          )),
                        })}
                      >
                        <option value="">Default wardrobe</option>
                        {wardrobeValue && !character.wardrobes.some((wardrobe) => wardrobe.id === wardrobeValue) && (
                          <option value={wardrobeValue}>Missing wardrobe ({wardrobeValue})</option>
                        )}
                        {character.wardrobes.map((wardrobe) => (
                          <option key={wardrobe.id} value={wardrobe.id}>{wardrobe.name || wardrobe.label || 'Wardrobe'}</option>
                        ))}
                      </select>
                    )}
                    {appearance && canonicalWardrobeLocked && (
                      <p className="text-[11px] text-port-accent">Locked to the loom&apos;s canonical protagonist wardrobe.</p>
                    )}
                    {appearance && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <input
                          className={fieldClass}
                          aria-label={`${character.name} expression`}
                          placeholder="Expression"
                          value={appearance.expression || ''}
                          onChange={(event) => setForm((current) => ({
                            ...current,
                            visualCanon: {
                              ...current.visualCanon,
                              characterAppearances: current.visualCanon.characterAppearances.map((item) => (
                                item.characterId === character.id ? { ...item, expression: event.target.value } : item
                              )),
                            },
                          }))}
                          onBlur={() => patchNode({ visualCanon: form.visualCanon })}
                        />
                        <input
                          className={fieldClass}
                          aria-label={`${character.name} continuity notes`}
                          placeholder="Continuity notes"
                          value={appearance.continuityNotes || ''}
                          onChange={(event) => setForm((current) => ({
                            ...current,
                            visualCanon: {
                              ...current.visualCanon,
                              characterAppearances: current.visualCanon.characterAppearances.map((item) => (
                                item.characterId === character.id ? { ...item, continuityNotes: event.target.value } : item
                              )),
                            },
                          }))}
                          onBlur={() => patchNode({ visualCanon: form.visualCanon })}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>

            <FormField label="Location" labelClassName={labelClass}>
              <select
                className={fieldClass}
                value={form.visualCanon.placeId || ''}
                onChange={(event) => updateVisualCanon({ placeId: event.target.value || null })}
              >
                <option value="">No bound location</option>
                {(universe?.places || []).map((place) => (
                  <option key={place.id} value={place.id}>{place.name || place.slugline}</option>
                ))}
              </select>
            </FormField>

            {(universe?.objects || []).length > 0 && (
              <fieldset className="space-y-1">
                <legend className={labelClass}>Props and objects</legend>
                {universe.objects.map((object) => (
                  <label key={object.id} className="flex items-center gap-2 text-xs" htmlFor={`loom-canon-object-${object.id}`}>
                    <input
                      id={`loom-canon-object-${object.id}`}
                      aria-label={object.name}
                      type="checkbox"
                      checked={form.visualCanon.objectIds.includes(object.id)}
                      onChange={(event) => updateVisualCanon({
                        objectIds: event.target.checked
                          ? [...form.visualCanon.objectIds, object.id]
                          : form.visualCanon.objectIds.filter((id) => id !== object.id),
                      })}
                    />
                    {object.name}
                  </label>
                ))}
              </fieldset>
            )}

            <FormField label="Continuity source" labelClassName={labelClass}>
              <select
                className={fieldClass}
                value={form.visualCanon.continuitySourceNodeId || ''}
                onChange={(event) => updateVisualCanon({ continuitySourceNodeId: event.target.value || null })}
              >
                <option value="">Automatic (only for one incoming scene)</option>
                {otherNodes.filter((candidate) => candidate.transitions?.some((transition) => transition.targetNodeId === node.id))
                  .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title || 'Untitled scene'}</option>)}
              </select>
            </FormField>

            <FormField label="Shot continuity notes" labelClassName={labelClass}>
              <textarea
                rows={2}
                className={fieldClass}
                value={form.visualCanon.shotNotes || ''}
                onChange={(event) => setForm((current) => ({
                  ...current, visualCanon: { ...current.visualCanon, shotNotes: event.target.value },
                }))}
                onBlur={() => patchNode({ visualCanon: form.visualCanon })}
              />
            </FormField>

            {node.image && (
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
          </div>
        )}
      </div>

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

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-port-text-muted">
            {form.playbackMode === 'cut' ? 'Next cut' : 'Viewer paths'} ({form.transitions.length})
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={runBranch}
              disabled={branching || aiBlocked || !audienceConnected}
              title={!audienceConnected ? 'Connect the audience communication medium before adding decision branches' : undefined}
              className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
            >
              {branching ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
              Branch with AI
            </button>
            <button
              type="button"
              onClick={addTransition}
              disabled={addingPath}
              className="text-xs text-port-accent hover:underline disabled:opacity-50"
            >
              + Add path
            </button>
          </div>
        </div>
        {form.isEnding && form.transitions.length > 0 && (
          <p className="text-xs text-port-warning mb-2">Endings never fire their outgoing paths.</p>
        )}
        {!form.isEnding && form.playbackMode === 'cut' && form.transitions.length !== 1 && (
          <p className="text-xs text-port-error mb-2">Automatic cuts need exactly one path to the next cut.</p>
        )}
        <div className="space-y-3">
          {form.transitions.map((tr, index) => (
            <div key={tr.id} className="border border-port-border rounded p-2 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  className={fieldClass}
                  placeholder='Reader intent, e.g. "search the wreck"'
                  aria-label="Intent"
                  value={tr.intent}
                  onChange={(e) => applyTransition(index, { intent: e.target.value })}
                  onBlur={() => saveTransition(tr)}
                />
                <button
                  type="button"
                  onClick={() => removeTransition(tr)}
                  className="text-port-text-muted hover:text-port-error shrink-0"
                  aria-label="Remove path"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <select
                className={fieldClass}
                aria-label="Leads to scene"
                value={tr.targetNodeId}
                onChange={(e) => applyTransition(index, { targetNodeId: e.target.value }, { save: true })}
              >
                {otherNodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.title || 'Untitled scene'}</option>
                ))}
              </select>
              <input
                className={fieldClass}
                placeholder="Example phrasings, separated by ;"
                aria-label="Trigger phrasings"
                value={tr.triggersText}
                onChange={(e) => applyTransition(index, { triggersText: e.target.value })}
                onBlur={() => saveTransition(tr)}
              />
            </div>
          ))}
          {!form.transitions.length && !form.isEnding && (
            <p className="text-xs text-port-warning">
              No paths out — mark this an ending or add a path.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
