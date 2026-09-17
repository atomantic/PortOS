import { useMemo, useState } from 'react';
import { Check, Square, CheckSquare } from 'lucide-react';
import { FormField } from '../ui/FormField';
import { formatCount } from '../../utils/formatters';
import {
  MODEL_ACCESS_MODES,
  MODEL_ACCESS_MODE_LABELS,
  MAX_MODEL_ACCESS_PATTERNS,
  modelMatchesAccessPatterns,
  previewModelAccess,
} from '../../utils/providerModelAccess';

/**
 * Editor for a provider's MODEL ACCESS policy — which of the catalog its
 * upstream advertises this install is actually entitled to run.
 *
 * Why a hand-curated list rather than a detected one: entitlement is not in the
 * catalog response. NVIDIA NIM's `/v1/models` answers with the full product line
 * and carries no pricing, tier or entitlement field, so the ~38 endpoints that
 * are free on build.nvidia.com are indistinguishable from the rest over the
 * wire. The same is true of a vendor key scoped to two models out of thirty.
 * The user is the only party that knows, so the editor's job is to make saying
 * it cheap: tick the models off the refreshed catalog, or write a glob when the
 * tier has a naming convention (OpenRouter's `*:free`).
 *
 * The two inputs are ONE list. A ticked checkbox writes the model's exact id as
 * a pattern, so a user can start from globs and refine by hand — and so the
 * saved policy always reads as exactly what it does.
 */
export default function ProviderModelAccess({ catalog, value, onChange, provider }) {
  const [patternDraft, setPatternDraft] = useState(null);

  const policy = value || { mode: 'all', patterns: [] };
  const patterns = policy.patterns || [];
  const preview = useMemo(
    () => previewModelAccess(catalog, policy, provider),
    [catalog, policy, provider],
  );

  const setPolicy = (next) => onChange({ mode: next.mode, patterns: next.patterns });
  const setPatterns = (next) => setPolicy({ ...policy, patterns: [...new Set(next)].slice(0, MAX_MODEL_ACCESS_PATTERNS) });

  const togglePattern = (model) => setPatterns(
    patterns.includes(model) ? patterns.filter(p => p !== model) : [...patterns, model],
  );

  // A checkbox means "this exact id is in the list", never "the policy admits
  // this model" — the two differ whenever a glob is in play, and conflating them
  // would make a `deny` list render inverted. A model a glob already covers gets
  // its own marker instead. Clicking such a row adds the exact id, which is
  // additive and harmless; rewriting the user's glob for them would silently
  // destroy the shorthand they typed.
  const coveredByGlob = (model) =>
    !patterns.includes(model) && modelMatchesAccessPatterns(model, patterns);

  return (
    <div className="space-y-4 border-t border-port-border pt-4">
      <FormField label="Model Access">
        <select
          id="provider-model-access-mode"
          value={policy.mode}
          onChange={(e) => setPolicy({ ...policy, mode: e.target.value })}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
        >
          {MODEL_ACCESS_MODES.map(mode => (
            <option key={mode} value={mode}>{MODEL_ACCESS_MODE_LABELS[mode]}</option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          Scopes every model picker in PortOS — and the model comparison chart — to the
          models this account can actually run. The provider&apos;s stored catalog is never
          narrowed, so switching back to &quot;All models&quot; restores it without a refresh.
        </p>
      </FormField>

      {policy.mode !== 'all' && (
        <>
          <p className={`text-xs ${preview.inert ? 'text-amber-400' : 'text-gray-400'}`}>
            {preview.inert
              ? 'No patterns yet — nothing is scoped until you tick a model or add a pattern below.'
              : `Showing ${formatCount(preview.visible.length)} of ${formatCount(preview.total)} models (${formatCount(preview.hidden)} hidden).`}
          </p>

          <FormField label="Patterns">
            <textarea
              id="provider-model-access-patterns"
              value={patternDraft ?? patterns.join('\n')}
              onChange={(e) => setPatternDraft(e.target.value)}
              onBlur={() => {
                setPatterns((patternDraft ?? '').split(/[\n,]/).map(p => p.trim()).filter(Boolean));
                setPatternDraft(null);
              }}
              placeholder={'meta/*\nnvidia/llama-3.1-nemotron-70b-instruct\n*:free'}
              rows={4}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-xs resize-none focus:border-port-accent focus:outline-hidden"
            />
            <p className="text-xs text-gray-500 mt-1">
              One per line. <code>*</code> matches any characters and <code>?</code> exactly one;
              everything else is literal, so a bare id is an exact pin. Matching is
              case-insensitive and always against the whole model id.
            </p>
          </FormField>

          {catalog.length > 0 && (
            <div>
              <p className="block text-sm text-gray-400 mb-1">Catalog ({formatCount(catalog.length)})</p>
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => setPatterns(catalog)}
                  className="px-2 py-1 text-xs bg-port-bg border border-port-border rounded-sm text-gray-300 hover:text-white"
                >Select all</button>
                <button
                  type="button"
                  onClick={() => setPatterns([])}
                  className="px-2 py-1 text-xs bg-port-bg border border-port-border rounded-sm text-gray-300 hover:text-white"
                >Clear</button>
              </div>
              <div className="max-h-64 overflow-y-auto border border-port-border rounded-lg divide-y divide-port-border">
                {catalog.map(model => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => togglePattern(model)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-port-bg"
                  >
                    {patterns.includes(model)
                      ? <CheckSquare className="w-3.5 h-3.5 shrink-0 text-port-accent" />
                      : <Square className="w-3.5 h-3.5 shrink-0 text-gray-600" />}
                    <span className="font-mono truncate">{model}</span>
                    {coveredByGlob(model) && (
                      <Check className="w-3.5 h-3.5 shrink-0 text-port-accent ml-auto" aria-label="matched by a pattern" />
                    )}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Ticking a model adds its exact id to the list above. A check on the right
                marks a model one of your globs already matches.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
