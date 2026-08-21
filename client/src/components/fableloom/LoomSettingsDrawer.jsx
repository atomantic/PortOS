/**
 * FableLoom story settings — the loom-level choices that steer every AI lane.
 *
 * Two things live here:
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

import { Loader2, Sparkles } from 'lucide-react';
import Drawer from '../Drawer';
import ProviderModelSelector from '../ProviderModelSelector';
import { FormField } from '../ui/FormField.jsx';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { effectiveModelFor, effortAwareModelOptions } from '../../utils/providers';
import { reformatLoom, updateLoom } from '../../services/api';
import { fieldClass, labelClass } from './fieldStyles';
import { LOOM_FORMATS, loomFormatHint, loomFormatLabel } from './loomFormats';

export default function LoomSettingsDrawer({ open, onClose, loom, onLoomUpdate }) {
  const { providers } = useProviderModels({ allowDefault: true, silent: true, withEffort: true });

  const format = loom.format || 'prose';
  const play = loom.playSettings || {};
  const playProvider = providers.find((p) => p.id === play.providerId);
  const sceneCount = loom.episodes.reduce((total, ep) => total + ep.nodes.length, 0);

  // The rewrite reads the format pin SERVER-side, so it stays disabled while a
  // pin save is in flight — otherwise picking teleplay and immediately
  // rewriting would rewrite into the previous format.
  const [patch, saving] = useAsyncAction(
    async (body) => onLoomUpdate(await updateLoom(loom.id, body, { silent: true })),
    { errorMessage: 'Save failed' },
  );

  // Clearing the provider clears the model and effort with it — neither is
  // meaningful (or necessarily valid) without the provider that offered them.
  const savePlay = (changes) => patch({
    playSettings: { providerId: play.providerId ?? null, model: play.model ?? null, effort: play.effort ?? null, ...changes },
  });

  const [runReformat, reformatting] = useAsyncAction(async () => {
    const result = await reformatLoom(loom.id, { format }, { silent: true });
    onLoomUpdate(result.loom);
    toast.success(`Rewrote ${result.rewritten} scene${result.rewritten === 1 ? '' : 's'} as ${loomFormatLabel(format).toLowerCase()}`);
  }, { errorMessage: 'The rewrite failed' });

  return (
    <Drawer open={open} onClose={onClose} title="Story settings" subtitle={loom.name} size="sm">
      <div className="space-y-5">
        <section className="space-y-2">
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
          </p>
          {sceneCount > 0 && (
            <button
              type="button"
              onClick={runReformat}
              disabled={reformatting || saving}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-port-border text-sm hover:border-port-accent disabled:opacity-60"
            >
              {reformatting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {reformatting
                ? 'Rewriting…'
                : `Rewrite all ${sceneCount} scene${sceneCount === 1 ? '' : 's'} as ${loomFormatLabel(format).toLowerCase()}`}
            </button>
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
