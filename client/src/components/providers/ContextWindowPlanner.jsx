import { useEffect, useState } from 'react';
import { getContextPlans } from '../../services/apiLocalLlm';
import { formatBytes, formatContextTokens } from '../../utils/formatters';
import { modelNumCtxToText, parseModelNumCtxText } from './providerFormData';

// Columns shown for every model; a model's own maximum is listed separately.
const COLUMNS = [32768, 131072, 262144, 1048576];

const CACHE_SOURCE_LABEL = { env: 'from PortOS env', 'brew-service': 'from the Homebrew service', default: 'assumed' };

/** Merge every plan's recommended window into the per-model text, keeping lines for models without a plan. */
export const withRecommendedWindows = (text, plans) => {
  const { map = {} } = parseModelNumCtxText(text);
  const next = { ...map };
  for (const plan of plans) if (plan.recommended) next[plan.modelId] = plan.recommended;
  return modelNumCtxToText(next);
};

function PlanCell({ plan, tokens }) {
  if (plan.nativeContext && tokens > plan.nativeContext) return <td className="px-2 py-1 text-gray-600">—</td>;
  const row = plan.rows.find((r) => r.tokens === tokens);
  if (!row) {
    return <td className="px-2 py-1 text-gray-500">{plan.lazyCache ? 'grows' : '?'}</td>;
  }
  const tone = row.fits === false ? 'text-port-error' : 'text-gray-300';
  return (
    <td className={`px-2 py-1 ${tone}`} title={`KV cache ${formatBytes(row.kvBytes)} + weights ${formatBytes(plan.weightsBytes || 0)}`}>
      {formatBytes(row.totalBytes)}
    </td>
  );
}

/**
 * What each installed Ollama model provisions at common windows (weights + KV
 * cache), against what this host can give one model, with a button that fills
 * the per-model field with the largest window that fits each.
 */
export default function ContextWindowPlanner({ modelNumCtxText, onChange }) {
  const [state, setState] = useState({ loading: true, data: null });

  useEffect(() => {
    let canceled = false;
    getContextPlans({ silent: true })
      .then((data) => { if (!canceled) setState({ loading: false, data }); })
      .catch(() => { if (!canceled) setState({ loading: false, data: null }); });
    return () => { canceled = true; };
  }, []);

  if (state.loading) return <p className="text-xs text-gray-500">Measuring installed models…</p>;
  const plans = (state.data?.plans || []).filter((plan) => plan.nativeContext);
  if (!plans.length) return null;
  const { budgetBytes, cacheType, cacheTypeSource } = state.data;

  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-gray-500">
        Memory each model needs at a window (weights + context cache, {cacheType} cache {CACHE_SOURCE_LABEL[cacheTypeSource] || ''}).
        {budgetBytes ? ` One model can use about ${formatBytes(budgetBytes)} here; red needs more than that.` : ''}
        {' '}MLX builds reserve no cache up front, so they show “grows”.
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs w-full">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="px-2 py-1 font-normal">Model</th>
              <th className="px-2 py-1 font-normal">Max</th>
              {COLUMNS.map((tokens) => <th key={tokens} className="px-2 py-1 font-normal">{formatContextTokens(tokens)}</th>)}
              <th className="px-2 py-1 font-normal">Best fit</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.modelId} className="border-t border-port-border">
                <td className="px-2 py-1 text-gray-300 break-all">{plan.modelId}</td>
                <td className="px-2 py-1 text-gray-400">{formatContextTokens(plan.nativeContext)}</td>
                {COLUMNS.map((tokens) => <PlanCell key={tokens} plan={plan} tokens={tokens} />)}
                <td className="px-2 py-1 text-port-accent">{plan.recommended ? formatContextTokens(plan.recommended) : 'none fits'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => onChange(withRecommendedWindows(modelNumCtxText, plans))}
        className="px-3 py-1.5 text-xs bg-port-border hover:bg-port-border/70 text-white rounded-lg"
      >
        Use best fit for every model
      </button>
    </div>
  );
}
