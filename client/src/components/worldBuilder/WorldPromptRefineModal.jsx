import { useEffect, useState } from 'react';
import { Check, Sparkles, Wand2, X } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels';
import { refineWorldPrompts } from '../../services/api';

/**
 * Refines the three top-level world prompts (Starter Idea, Style Prompt,
 * Negative Prompt) based on user feedback. Mirrors PromptRefineModal's
 * shape — feedback box, provider/model selector, refined-fields review,
 * then apply.
 *
 * The modal is stateless from the server's perspective: applying the
 * refinement writes back to the page-level draft, and saving the world
 * is the user's choice (matches existing expansion-flow behavior).
 */
export default function WorldPromptRefineModal({
  open,
  onClose,
  onApply,
  starterPrompt = '',
  stylePrompt = '',
  negativePrompt = '',
  // Optional pre-selected provider/model — when a world already pins an LLM
  // for expansion, default the refiner to the same combo so the user doesn't
  // have to re-pick.
  defaultProviderId = null,
  defaultModel = null,
}) {
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels();

  const [feedback, setFeedback] = useState('');
  const [refinedStarter, setRefinedStarter] = useState('');
  const [refinedStyle, setRefinedStyle] = useState('');
  const [refinedNegative, setRefinedNegative] = useState('');
  const [rationale, setRationale] = useState('');
  const [changes, setChanges] = useState([]);
  const [refining, setRefining] = useState(false);

  // Reset transient state every time the modal is re-opened so a previous
  // refinement doesn't leak into a new session.
  useEffect(() => {
    if (!open) return;
    setFeedback('');
    setRefinedStarter('');
    setRefinedStyle('');
    setRefinedNegative('');
    setRationale('');
    setChanges([]);
  }, [open]);

  // Seed the provider/model picker from the world's stored LLM choice the
  // first time it becomes available — but never clobber an in-flight user
  // selection.
  useEffect(() => {
    if (!open) return;
    if (defaultProviderId && !selectedProviderId) {
      setSelectedProviderId(defaultProviderId);
      if (defaultModel) setSelectedModel(defaultModel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProviderId, defaultModel]);

  if (!open) return null;

  const hasResult = refinedStarter !== '' || rationale !== '';
  const canRefine = feedback.trim() && starterPrompt.trim() && selectedProviderId && !refining;
  const canApply = hasResult && refinedStarter.trim();

  const runRefine = async () => {
    if (!canRefine) return;
    setRefining(true);
    setRefinedStarter('');
    setRefinedStyle('');
    setRefinedNegative('');
    setRationale('');
    setChanges([]);
    const result = await refineWorldPrompts({
      starterPrompt,
      stylePrompt,
      negativePrompt,
      feedback: feedback.trim(),
      providerId: selectedProviderId,
      model: selectedModel || undefined,
    }).catch(() => null); // services/apiCore#request already toasts on errors.
    setRefining(false);
    if (!result) return;
    setRefinedStarter(result.starterPrompt || '');
    setRefinedStyle(result.stylePrompt || '');
    setRefinedNegative(result.negativePrompt || '');
    setRationale(result.rationale || '');
    setChanges(Array.isArray(result.changes) ? result.changes : []);
  };

  const handleApply = () => {
    if (!canApply) return;
    onApply({
      starterPrompt: refinedStarter.trim(),
      stylePrompt: refinedStyle.trim(),
      negativePrompt: refinedNegative.trim(),
    });
    toast.success('Refined prompts applied');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <section
        className="w-full max-w-3xl max-h-[90vh] overflow-hidden bg-port-card border border-port-border rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="world-refine-title"
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-port-border">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-port-accent shrink-0" />
            <h2 id="world-refine-title" className="text-sm font-semibold text-white">
              Refine world prompts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <p className="text-xs text-gray-400">
            Describe what you want the world to feel like — story tone, era, art-direction
            references, what to avoid. The LLM rewrites your Starter Idea, Style Prompt, and
            Negative Prompt to match. Review the result before applying.
          </p>

          {/* Originals — collapsed-ish read-only preview so the user remembers
              what's about to change. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <ReadOnlyField label="Starter idea" value={starterPrompt} />
            <ReadOnlyField label="Style prompt" value={stylePrompt} />
            <ReadOnlyField label="Negative prompt" value={negativePrompt} />
          </div>

          <div>
            <label htmlFor="world-refine-feedback" className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
              Feedback
            </label>
            <textarea
              id="world-refine-feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g. lean grimmer and more spiritual; pull style toward Moebius + Tarkovsky; avoid neon and cyberpunk clichés."
              rows={4}
              className="w-full bg-port-bg border border-port-border rounded-lg p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent resize-y"
            />
          </div>

          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            label="LLM Provider"
            disabled={providersLoading || refining}
          />

          {providers.length === 0 && !providersLoading && (
            <p className="text-xs text-port-warning">No enabled providers are configured.</p>
          )}

          {!starterPrompt.trim() && (
            <p className="text-xs text-port-warning">
              Add a starter idea on the world first — there's nothing for the LLM to refine.
            </p>
          )}

          <button
            type="button"
            onClick={runRefine}
            disabled={!canRefine}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
          >
            <Wand2 className="w-4 h-4" />
            {refining ? 'Refining…' : (hasResult ? 'Refine again' : 'Refine prompts')}
          </button>

          {hasResult && (
            <div className="space-y-4">
              {rationale && (
                <p className="text-sm text-gray-300 bg-port-bg border border-port-border rounded-lg p-3">
                  {rationale}
                </p>
              )}

              {changes.length > 0 && (
                <ul className="text-xs text-gray-400 list-disc pl-5 space-y-0.5">
                  {changes.map((c, idx) => (
                    <li key={`${c.slice(0, 24)}-${idx}`}>{c}</li>
                  ))}
                </ul>
              )}

              <RefinedTextarea
                label="New starter idea"
                value={refinedStarter}
                onChange={setRefinedStarter}
                rows={3}
              />
              <RefinedTextarea
                label="New style prompt"
                value={refinedStyle}
                onChange={setRefinedStyle}
                rows={4}
              />
              <RefinedTextarea
                label="New negative prompt"
                value={refinedNegative}
                onChange={setRefinedNegative}
                rows={3}
              />
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-port-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-port-border/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-success text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
          >
            <Check className="w-4 h-4" />
            Apply to world
          </button>
        </footer>
      </section>
    </div>
  );
}

function ReadOnlyField({ label, value }) {
  return (
    <div className="bg-port-bg border border-port-border rounded p-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      <div className="text-[11px] text-gray-300 line-clamp-4 whitespace-pre-wrap">
        {value?.trim() ? value : <span className="text-gray-600">(empty)</span>}
      </div>
    </div>
  );
}

function RefinedTextarea({ label, value, onChange, rows }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full bg-port-bg border border-port-border rounded-lg p-3 text-sm text-white focus:outline-none focus:border-port-accent resize-y"
      />
    </div>
  );
}
