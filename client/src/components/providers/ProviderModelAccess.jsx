import { useMemo, useState } from 'react';
import { Check, Square, CheckSquare } from 'lucide-react';
import { FormField } from '../ui/FormField';
import { formatCount } from '../../utils/formatters';
import {
  MODEL_ACCESS_MODES,
  MODEL_ACCESS_MODE_LABELS,
  MAX_MODEL_ACCESS_PATTERNS,
  NO_MODEL_ACCESS,
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
 *
 * `configuredModels` is passed rather than a provider record so the memos below
 * can key on values that actually change; a record rebuilt each render would
 * make every keystroke in any other form field re-scope the whole catalog.
 */
export default function ProviderModelAccess({ catalog, value, onChange, configuredModels }) {
  const [patternDraft, setPatternDraft] = useState(null);

  const policy = value || NO_MODEL_ACCESS;
  const patterns = policy.patterns || NO_MODEL_ACCESS.patterns;
  const preview = useMemo(
    () => previewModelAccess(catalog, policy, configuredModels),
    [catalog, policy, configuredModels],
  );

  // One pass over the catalog for the row markers, so a row is O(1) rather than
  // two linear `includes` scans plus a glob sweep each. At the 500-pattern cap
  // the per-row form was ~500k comparisons on every keystroke in the textarea.
  const { listed, globCovered } = useMemo(() => {
    const selected = new Set(patterns);
    return {
      listed: selected,
      globCovered: new Set(catalog.filter(
        model => !selected.has(model) && modelMatchesAccessPatterns(model, patterns),
      )),
    };
  }, [catalog, patterns]);

  const setPolicy = (next) => onChange({ mode: next.mode, patterns: next.patterns });
  const setPatterns = (next) => setPolicy({ ...policy, patterns: [...new Set(next)].slice(0, MAX_MODEL_ACCESS_PATTERNS) });

  const togglePattern = (model) => setPatterns(
    listed.has(model) ? patterns.filter(p => p !== model) : [...patterns, model],
  );

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
              : `Showing ${formatCount(preview.visibleCount)} of ${formatCount(preview.total)} models (${formatCount(preview.hidden)} hidden).`}
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
                    // The row IS a checkbox; without this a screen reader hears
                    // "<model id>, button" with no indication of whether it is in
                    // the list, which is the whole state this control carries.
                    aria-pressed={listed.has(model)}
                    onClick={() => togglePattern(model)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-port-bg"
                  >
                    {listed.has(model)
                      ? <CheckSquare className="w-3.5 h-3.5 shrink-0 text-port-accent" />
                      : <Square className="w-3.5 h-3.5 shrink-0 text-gray-600" />}
                    <span className="font-mono truncate">{model}</span>
                    {globCovered.has(model) && (
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
