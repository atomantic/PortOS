/**
 * FableLoom story settings — the loom-level choices that steer every AI lane.
 *
 * Three things live here:
 *   - **Audience participation.** Whether the audience acts as the protagonist
 *     or helps an autonomous protagonist through a named in-story channel.
 *   - **Scene format.** Whether scenes are written as narrated prose or as a
 *     teleplay. The setting is a pin: weave, branch, and play all render the
 *     matching format contract into their prompts. Changing it does NOT
 *     rewrite what is already authored — the separate "Rewrite every scene"
 *     action does that, as an explicit user-triggered pass (AI Provider Usage
 *     Policy), naming the provider it will use.
 *   - **Narrator routing.** Which provider/model/effort turns a reader's free
 *     text into a path during play. Unset means the play stage's own pin (or
 *     the install's active provider) — a tapped path never calls a provider at
 *     all, so this only governs typed input.
 */

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import Drawer from '../Drawer';
import ProviderModelSelector from '../ProviderModelSelector';
import { FormField } from '../ui/FormField.jsx';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { effectiveModelFor, effortAwareModelOptions } from '../../utils/providers';
import { reformatLoomEpisode, updateLoom } from '../../services/api';
import { fieldClass, labelClass } from './fieldStyles';
import { LOOM_FORMATS, episodesNeedingReformat, loomFormatHint, loomFormatLabel } from './loomFormats';
import { FABLELOOM_PARTICIPATION_MODES } from '../../../../server/lib/fableLoomParticipation.js';

/**
 * The one line of feedback a multi-minute rewrite gives. Built as a single
 * string so the walk reads as one sentence rather than as fragments a screen
 * reader announces separately.
 */
const rewriteProgressLabel = ({ index, total, title, scenesLeft }) => [
  `Rewriting episode ${index} of ${total}`,
  title ? ` — ${title}` : '',
  '…',
  scenesLeft ? ` ${scenesLeft} scene${scenesLeft === 1 ? '' : 's'} left in it.` : '',
].join('');

export default function LoomSettingsDrawer({ open, onClose, loom, universe, onLoomUpdate, onRewritten }) {
  const { providers } = useProviderModels({ allowDefault: true, silent: true, withEffort: true });

  // Which episode the rewrite is on. The walk is one request per episode, so
  // this is the only feedback a multi-minute pass gives — without it the button
  // spins for minutes with nothing to show which of five episodes is in flight.
  const [rewritingEpisode, setRewritingEpisode] = useState(null);

  const format = loom.format || 'prose';
  const [participationMode, setParticipationMode] = useState(loom.participationMode || 'protagonist');
  const [communicationMedium, setCommunicationMedium] = useState(loom.audienceCommunicationMedium || '');
  const [protagonistCharacterId, setProtagonistCharacterId] = useState(loom.protagonistCharacterId || '');
  const [protagonistWardrobeId, setProtagonistWardrobeId] = useState(loom.protagonistWardrobeId || '');
  const [protagonistWardrobeLocked, setProtagonistWardrobeLocked] = useState(loom.protagonistWardrobeLocked === true);
  useEffect(() => {
    if (open) return;
    setParticipationMode(loom.participationMode || 'protagonist');
    setCommunicationMedium(loom.audienceCommunicationMedium || '');
    setProtagonistCharacterId(loom.protagonistCharacterId || '');
    setProtagonistWardrobeId(loom.protagonistWardrobeId || '');
    setProtagonistWardrobeLocked(loom.protagonistWardrobeLocked === true);
  }, [open, loom.participationMode, loom.audienceCommunicationMedium, loom.protagonistCharacterId, loom.protagonistWardrobeId, loom.protagonistWardrobeLocked]);
  const play = loom.playSettings || {};
  const playProvider = providers.find((p) => p.id === play.providerId);
  // Only scenes not already in the target format are sent, so this is what the
  // rewrite will actually cost — and it ticks down as each episode lands.
  const pendingEpisodes = episodesNeedingReformat(loom, format);
  const pendingScenes = pendingEpisodes.reduce((total, e) => total + e.sceneCount, 0);
  const sceneCount = loom.episodes.reduce((total, ep) => total + ep.nodes.length, 0);

  // The rewrite reads the format pin SERVER-side, so it stays disabled while a
  // pin save is in flight — otherwise picking teleplay and immediately
  // rewriting would rewrite into the previous format.
  const [patch, saving] = useAsyncAction(
    async (body) => onLoomUpdate(await updateLoom(loom.id, body, { silent: true })),
    { errorMessage: 'Save failed' },
  );

  const universeCharacters = Array.isArray(universe?.characters) ? universe.characters : [];
  const protagonist = universeCharacters.find((character) => character.id === protagonistCharacterId) || null;
  const protagonistWardrobes = Array.isArray(protagonist?.wardrobes) ? protagonist.wardrobes : [];
  const protagonistSheets = [
    protagonist?.referenceSheetImageRef,
    ...Object.values(protagonist?.referenceSheets || {}),
  ].filter(Boolean);
  const approvedIdentityRoles = new Set(
    (Array.isArray(protagonist?.identityPack?.assets) ? protagonist.identityPack.assets : [])
      .filter((asset) => asset?.approved === true)
      .map((asset) => asset.role),
  );
  const missingIdentityRoles = ['neutral', 'profile', 'full-body'].filter((role) => !approvedIdentityRoles.has(role));
  const linkedUniverseId = universe?.id || loom.universeId || null;

  const saveProtagonist = (changes) => patch(changes);

  const chooseProtagonist = (event) => {
    const nextId = event.target.value;
    const nextCharacter = universeCharacters.find((character) => character.id === nextId);
    const nextWardrobe = protagonistWardrobeId && nextCharacter?.wardrobes?.some((wardrobe) => wardrobe.id === protagonistWardrobeId)
      ? protagonistWardrobeId
      : '';
    setProtagonistCharacterId(nextId);
    setProtagonistWardrobeId(nextWardrobe);
    setProtagonistWardrobeLocked(Boolean(nextWardrobe));
    saveProtagonist({
      protagonistCharacterId: nextId || null,
      protagonistWardrobeId: nextWardrobe || null,
      protagonistWardrobeLocked: Boolean(nextWardrobe),
    });
  };

  const chooseProtagonistWardrobe = (event) => {
    const nextId = event.target.value;
    setProtagonistWardrobeId(nextId);
    setProtagonistWardrobeLocked(Boolean(nextId));
    saveProtagonist({
      protagonistWardrobeId: nextId || null,
      protagonistWardrobeLocked: Boolean(nextId),
    });
  };

  // The merge base is a ref, not the render-time props, because the picker can
  // emit TWO changes in one tick: choosing a model whose provider tier has no
  // effort ladder also clears the effort. Both callbacks would otherwise build
  // their payload from the same pre-change props, and since a PATCH replaces
  // `playSettings` wholesale the second would put the just-picked model back to
  // what it was. Props re-seed the ref whenever the server echo lands.
  const pendingPlay = useRef(null);
  if (!pendingPlay.current || !saving) pendingPlay.current = { providerId: play.providerId ?? null, model: play.model ?? null, effort: play.effort ?? null };

  // Clearing the provider clears the model and effort with it — neither is
  // meaningful (or necessarily valid) without the provider that offered them.
  const savePlay = (changes) => {
    pendingPlay.current = { ...pendingPlay.current, ...changes };
    return patch({ playSettings: { ...pendingPlay.current } });
  };

  // One request per episode. A whole-loom rewrite used to run every provider
  // call behind a single held request — minutes long, with a fetch timeout free
  // to kill the response while the server kept writing. The loom's format pin
  // is still the SERVER's call: it lands only once no episode has an
  // unconverted scene left, so a walk interrupted here can't leave the loom
  // claiming a format half its story isn't in.
  //
  // `onRewritten` fires on BOTH paths on purpose. A rewrite persists each
  // chunk as it lands, so even a run that throws part-way has already changed
  // scene text on the server — any editor still holding the pre-rewrite text
  // would write it back on its next blur-save.
  const [runReformat, reformatting] = useAsyncAction(async () => {
    // Clear the scene selection UP FRONT. A multi-episode run takes minutes, and
    // the page underneath stays interactive — an editor still holding the
    // pre-rewrite text would write it back on any blur during that window, not
    // just after the run settles.
    onRewritten?.({ refetch: false });
    // The walk is the snapshot this closure captured: folding each response
    // back in re-renders the drawer with a shorter pending list, and iterating
    // the live one would drop episodes out from under the loop.
    const walk = pendingEpisodes;
    let rewritten = 0;
    let remaining = 0;
    try {
      for (const [index, { episode }] of walk.entries()) {
        let scenesLeft = null;
        // A long episode comes back `capped` — the request stopped at its own
        // ceiling with scenes it never sent. Asking again continues from there,
        // and each pass rewrites at least one scene, so this terminates. A
        // response that is NOT capped is done with this episode even if the
        // model dropped a scene: re-sending a refusal isn't progress, and the
        // leftover is reported in the "run it again to finish" toast.
        do {
          setRewritingEpisode({ title: episode.title, index: index + 1, total: walk.length, scenesLeft });
          const result = await reformatLoomEpisode(loom.id, episode.id, { format }, { silent: true });
          rewritten += result.rewritten;
          remaining = result.remaining;
          scenesLeft = result.capped ? result.episodeRemaining : null;
          // Fold each response back in as it lands, so the pending count and the
          // story underneath track the run instead of jumping at the end.
          onLoomUpdate(result.loom);
        } while (scenesLeft);
      }
    } finally {
      setRewritingEpisode(null);
      onRewritten?.();
    }
    toast.success(remaining
      ? `Rewrote ${rewritten} scene${rewritten === 1 ? '' : 's'} — ${remaining} left, run it again to finish`
      : `Rewrote ${rewritten} scene${rewritten === 1 ? '' : 's'} as ${loomFormatLabel(format).toLowerCase()}`);
  }, { errorMessage: 'The rewrite failed' });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Story settings"
      subtitle={loom.name}
      size="sm"
      closeOnEsc={!reformatting}
      closeOnBackdrop={!reformatting}
    >
      <div className="space-y-5">
        <section className="space-y-2">
          <FormField label="Audience role" labelClassName={labelClass}>
            <select
              className={fieldClass}
              value={participationMode}
              disabled={saving || reformatting}
              onChange={(event) => {
                const mode = event.target.value;
                setParticipationMode(mode);
                if (mode === 'protagonist' || communicationMedium.trim()) {
                  patch({
                    participationMode: mode,
                    ...(mode === 'helper' ? { audienceCommunicationMedium: communicationMedium.trim() } : {}),
                  });
                }
              }}
            >
              {FABLELOOM_PARTICIPATION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode === 'helper' ? 'Audience helps the protagonist' : 'Audience acts as the protagonist'}
                </option>
              ))}
            </select>
          </FormField>
          <p className="text-xs text-port-text-muted">
            {participationMode === 'helper'
              ? 'The protagonist keeps their own agency. The audience can advise them only while an in-story connection is working.'
              : 'The audience chooses the protagonist’s actions directly, like a classic choose-your-own adventure.'}
          </p>
          {participationMode === 'helper' && (
            <FormField label="Communication medium" labelClassName={labelClass}>
              <textarea
                rows={3}
                className={fieldClass}
                value={communicationMedium}
                onChange={(event) => setCommunicationMedium(event.target.value)}
                onBlur={() => {
                  if (communicationMedium.trim() !== (loom.audienceCommunicationMedium || '')) {
                    patch({ participationMode: 'helper', audienceCommunicationMedium: communicationMedium.trim() });
                  }
                }}
                placeholder="How the protagonist hears the audience: radio, telepathy, magic device, phone…"
              />
              {!communicationMedium.trim() && (
                <p className="text-xs text-port-warning mt-1">
                  Helper stories need a communication medium before the role can be saved.
                </p>
              )}
            </FormField>
          )}
        </section>

        <section className="border-t border-port-border pt-4 space-y-3">
          <div>
            <h4 className="text-sm font-semibold">Character continuity</h4>
            <p className="mt-1 text-xs text-port-text-muted">
              Set the one Universe character and wardrobe that anchor every on-screen protagonist beat. Scene editors can mark a beat off-screen when the audience is speaking with the protagonist on another device.
            </p>
          </div>
          {!universe ? (
            <div className="rounded border border-port-warning/40 bg-port-warning/5 p-3 text-xs text-port-warning">
              Link a Universe before binding a canonical protagonist, character sheets, or wardrobe references.
              {linkedUniverseId && (
                <Link to={`/universes/${encodeURIComponent(linkedUniverseId)}?tab=cast`} className="ml-1 underline">
                  Open Universe Cast
                </Link>
              )}
            </div>
          ) : (
            <>
              <FormField label="Canonical protagonist" labelClassName={labelClass}>
                <select
                  className={fieldClass}
                  aria-label="Canonical protagonist"
                  value={protagonistCharacterId}
                  disabled={saving || reformatting}
                  onChange={chooseProtagonist}
                >
                  <option value="">Choose a Universe character</option>
                  {protagonistCharacterId && !protagonist && (
                    <option value={protagonistCharacterId}>Missing Universe character ({protagonistCharacterId})</option>
                  )}
                  {universeCharacters.map((character) => (
                    <option key={character.id} value={character.id}>{character.name || character.id}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Canonical wardrobe" labelClassName={labelClass}>
                <select
                  className={fieldClass}
                  aria-label="Canonical protagonist wardrobe"
                  value={protagonistWardrobeId}
                  disabled={!protagonist || saving || reformatting}
                  onChange={chooseProtagonistWardrobe}
                >
                  <option value="">Choose a wardrobe reference</option>
                  {protagonistWardrobeId && !protagonistWardrobes.some((wardrobe) => wardrobe.id === protagonistWardrobeId) && (
                    <option value={protagonistWardrobeId}>Missing wardrobe ({protagonistWardrobeId})</option>
                  )}
                  {protagonistWardrobes.map((wardrobe) => (
                    <option key={wardrobe.id} value={wardrobe.id}>{wardrobe.name || wardrobe.label || 'Wardrobe'}</option>
                  ))}
                </select>
              </FormField>
              <label className="flex items-start gap-2 text-xs" htmlFor="loom-protagonist-wardrobe-locked">
                <input
                  id="loom-protagonist-wardrobe-locked"
                  type="checkbox"
                  checked={protagonistWardrobeLocked}
                  disabled={!protagonistWardrobeId || saving || reformatting}
                  onChange={(event) => {
                    const locked = event.target.checked;
                    setProtagonistWardrobeLocked(locked);
                    saveProtagonist({ protagonistWardrobeLocked: locked });
                  }}
                />
                <span>
                  Lock this wardrobe across on-screen scenes
                  <span className="mt-0.5 block text-[11px] text-port-text-muted">When locked, stale scene wardrobe choices are replaced by this canonical reference at render time.</span>
                </span>
              </label>
              {protagonist && (
                <div className="rounded border border-port-border/70 bg-port-bg/40 p-2.5 text-xs" role="status">
                  <div className="flex items-center gap-1.5 font-medium">
                    {protagonistSheets.length > 0 ? <CheckCircle2 size={13} className="text-port-success" /> : null}
                    {protagonist.name || protagonist.id}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                    <span className={protagonistSheets.length ? 'text-port-success' : 'text-port-warning'}>
                      {protagonistSheets.length ? `${protagonistSheets.length} character sheet${protagonistSheets.length === 1 ? '' : 's'}` : 'Needs character sheet'}
                    </span>
                    <span className={missingIdentityRoles.length ? 'text-port-warning' : 'text-port-success'}>
                      {missingIdentityRoles.length ? `Identity pack missing ${missingIdentityRoles.join(', ')}` : 'Identity pack ready'}
                    </span>
                  </div>
                  {linkedUniverseId && (
                    <Link to={`/universes/${encodeURIComponent(linkedUniverseId)}?tab=cast`} className="mt-1 inline-block text-[11px] text-port-accent hover:underline">
                      Open character sheets and wardrobe references
                    </Link>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        <section className="border-t border-port-border pt-4 space-y-2">
          <FormField label="Scene format" labelClassName={labelClass}>
            <select
              className={fieldClass}
              value={format}
              disabled={saving || reformatting}
              onChange={(e) => patch({ format: e.target.value })}
            >
              {LOOM_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </FormField>
          <p className="text-xs text-port-text-muted">
            {loomFormatHint(format)} New scenes are written this way — scenes
            you already have keep their current text until you rewrite them.
            {sceneCount > 0 && pendingScenes === 0 && ` Every scene you have is already written as ${loomFormatLabel(format).toLowerCase()}.`}
          </p>
          {pendingScenes > 0 && (
            <button
              type="button"
              onClick={runReformat}
              disabled={reformatting || saving}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-port-border text-sm hover:border-port-accent disabled:opacity-60"
            >
              {reformatting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {reformatting
                ? 'Rewriting…'
                : `Rewrite ${pendingScenes} scene${pendingScenes === 1 ? '' : 's'} as ${loomFormatLabel(format).toLowerCase()}`}
            </button>
          )}
          {rewritingEpisode && (
            <p className="text-xs text-port-text-muted" aria-live="polite">
              {rewriteProgressLabel(rewritingEpisode)}
            </p>
          )}
        </section>

        <section className="border-t border-port-border pt-4 space-y-2">
          <h4 className="text-sm font-semibold">Narrator</h4>
          <p className="text-xs text-port-text-muted">
            Turns what a reader types into one of the scene's paths. Tapping a path skips the AI
            entirely, so this only runs on typed input.
          </p>
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={play.providerId || ''}
            selectedModel={play.model || ''}
            availableModels={effortAwareModelOptions(playProvider, play.model)}
            onProviderChange={(providerId) => savePlay({ providerId: providerId || null, model: null, effort: null })}
            onModelChange={(model) => savePlay({ model: model || null })}
            effort={play.effort || ''}
            onEffortChange={(effort) => savePlay({ effort: effort || null })}
            label="Provider"
            layout="stacked"
            disabled={saving}
            modelDisabled={saving}
            emptyProviderOption="Default (whatever the play stage uses)"
            emptyModelOption="Default model"
            alwaysShowModel={!!play.providerId}
          />
          {playProvider && (
            <p className="text-xs text-port-text-muted">
              Reader input is sent to {playProvider.name}
              {effectiveModelFor(playProvider, play.model) ? ` (${effectiveModelFor(playProvider, play.model)})` : ''}.
            </p>
          )}
        </section>
      </div>
    </Drawer>
  );
}
