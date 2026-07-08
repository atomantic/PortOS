import { useState, useEffect, useCallback } from 'react';
import { Telescope, RefreshCw, Sparkles, Music, Tv, Clock, AlertTriangle, CheckCircle } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import MarkdownOutput from '../cos/MarkdownOutput';

// Divergence badge: divergence is SIGNAL, not error — stated and observed
// chronotypes differing is a legitimate insight, so we frame it neutrally.
function DivergenceBadge({ comparison }) {
  if (!comparison || comparison.divergence === 'unknown') return null;
  const { divergence, statedType, observedType } = comparison;
  if (divergence === 'none') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded bg-port-success/15 text-port-success border border-port-success/30">
        <CheckCircle size={12} /> Stated &amp; observed agree ({statedType})
      </span>
    );
  }
  const tone = divergence === 'strong'
    ? 'bg-port-warning/15 text-port-warning border-port-warning/30'
    : 'bg-port-accent/15 text-port-accent border-port-accent/30';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border ${tone}`}>
      <AlertTriangle size={12} /> Stated {statedType} vs observed {observedType} — {divergence} divergence
    </span>
  );
}

function TopList({ title, items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((x) => (
          <span key={x.name} className="text-xs px-2 py-0.5 rounded-full bg-port-bg border border-port-border text-gray-300">
            {x.name} <span className="text-gray-500">×{x.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function fmtHour(h) {
  if (h == null) return '—';
  const suffix = h < 12 ? 'am' : 'pm';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${suffix}`;
}

function fmtNovelty(nv) {
  if (!nv || nv.noveltyRatio == null) return null;
  return `${Math.round(nv.noveltyRatio * 100)}% novel · ${nv.distinct}/${nv.total} distinct`;
}

// A tiny CSS-only 24-bar histogram so chronotype timing reads at a glance
// (mobile-friendly, no chart lib). Bars scale to the busiest hour.
function HourBars({ histogram }) {
  if (!Array.isArray(histogram) || histogram.length === 0) return null;
  const max = Math.max(1, ...histogram.map((s) => s.total || 0));
  return (
    <div className="flex items-end gap-[2px] h-16" aria-hidden="true">
      {histogram.map((s) => (
        <div
          key={s.hour}
          title={`${fmtHour(s.hour)}: ${s.total} event(s)`}
          className="flex-1 bg-port-accent-2/60 rounded-t"
          style={{ height: `${Math.max(3, ((s.total || 0) / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Observed-behavior evidence for the taste profile (Phase 7, #2156). Surfaces
 * the LLM-free rollups (top artists/genres/channels/topics + novelty) and the
 * stated-vs-observed chronotype divergence, with a "Recompute" (LLM-free) and an
 * explicit "Interpret with AI" action that names the provider before it runs.
 */
export default function ObservedTasteEvidence() {
  const [evidence, setEvidence] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [providers, setProviders] = useState([]);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    const [ev, provData] = await Promise.all([
      api.getTwinEvidence({ silent: true }).catch(() => null),
      api.getProviders().catch(() => ({ providers: [] })),
    ]);
    if (ev) setEvidence(ev);
    const enabled = (provData.providers || []).filter((p) => p.enabled);
    setProviders(enabled);
    if (enabled.length > 0) setSelected({ providerId: enabled[0].id, model: enabled[0].defaultModel || '' });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRecompute = async () => {
    setRecomputing(true);
    // silent: this handler owns its own failure toast (avoid a double toast).
    const res = await api.recomputeTwinEvidence({ silent: true }).catch(() => null);
    setRecomputing(false);
    if (!res) { toast('Recompute failed', { icon: '⚠️' }); return; }
    setEvidence(res.evidence);
    toast('Observed evidence recomputed', { icon: '🧭' });
  };

  const handleInterpret = async () => {
    if (!selected?.providerId) { toast('Select an AI provider first', { icon: '⚠️' }); return; }
    setInterpreting(true);
    // silent: this handler surfaces the error message itself (avoid a double toast).
    const res = await api.interpretTwinConsumption(selected.providerId, selected.model || undefined, { silent: true })
      .catch((err) => { toast(err?.message || 'Interpretation failed', { icon: '⚠️' }); return null; });
    setInterpreting(false);
    if (!res?.interpretation) return;
    // Reactively splice the new interpretation into local state (no refetch).
    setEvidence((prev) => ({
      ...(prev || {}),
      taste: { ...(prev?.taste || {}), interpretation: res.interpretation },
    }));
    toast('Interpretation generated', { icon: '✨' });
  };

  if (loading) {
    return (
      <div className="bg-port-card rounded-lg border border-port-border p-6 flex items-center justify-center h-24">
        <BrailleSpinner text="Loading evidence" />
      </div>
    );
  }

  const taste = evidence?.taste;
  const chronotype = evidence?.chronotype;
  const month = taste?.windows?.month;
  const week = taste?.windows?.week;
  const interpretation = taste?.interpretation;
  const hasEvidence = Boolean(taste || chronotype);
  const selectedProvider = providers.find((p) => p.id === selected?.providerId);

  return (
    <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <Telescope className="w-5 h-5 text-port-accent-2 shrink-0" />
          <div>
            <h3 className="text-base font-semibold text-white">Observed from your behavior</h3>
            <p className="text-xs text-gray-500">
              LLM-free rollups of what you actually listen to, watch, and when you&apos;re active — supplements (never overwrites) your stated answers.
            </p>
          </div>
        </div>
        <button
          onClick={handleRecompute}
          disabled={recomputing}
          className="flex items-center justify-center gap-2 px-3 py-2 min-h-[40px] text-sm bg-port-bg border border-port-border rounded-lg text-gray-300 hover:text-white hover:border-port-accent/50 disabled:opacity-50"
        >
          {recomputing ? <BrailleSpinner /> : <RefreshCw size={15} />}
          Recompute
        </button>
      </div>

      {!hasEvidence && (
        <div className="text-sm text-gray-400 bg-port-bg border border-port-border rounded-lg p-4">
          No observed evidence yet. Once you&apos;ve synced Spotify / YouTube history (or logged activity), hit
          {' '}<span className="text-gray-300">Recompute</span> to build your evidence profile.
        </div>
      )}

      {/* Media taste rollups */}
      {(month?.listen?.total > 0 || month?.watch?.total > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-port-bg rounded-lg border border-port-border p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm text-white">
              <Music size={15} className="text-green-400" /> Listening
              <span className="text-gray-500 text-xs">
                {week?.listen?.total || 0}/wk · {month?.listen?.total || 0}/mo
              </span>
            </div>
            <TopList title="Top artists (30d)" items={month?.listen?.topArtists} />
            <TopList title="Top genres (30d)" items={month?.listen?.topGenres} />
            {fmtNovelty(month?.listen?.novelty) && (
              <div className="text-xs text-gray-500">{fmtNovelty(month.listen.novelty)}</div>
            )}
          </div>
          <div className="bg-port-bg rounded-lg border border-port-border p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm text-white">
              <Tv size={15} className="text-red-400" /> Watching
              <span className="text-gray-500 text-xs">
                {week?.watch?.total || 0}/wk · {month?.watch?.total || 0}/mo
              </span>
            </div>
            <TopList title="Top channels (30d)" items={month?.watch?.topChannels} />
            <TopList title="Top topics (30d)" items={month?.watch?.topTopics} />
            {fmtNovelty(month?.watch?.novelty) && (
              <div className="text-xs text-gray-500">{fmtNovelty(month.watch.novelty)}</div>
            )}
          </div>
        </div>
      )}

      {/* Chronotype: stated vs observed */}
      {chronotype && (
        <div className="bg-port-bg rounded-lg border border-port-border p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-2 text-sm text-white">
              <Clock size={15} className="text-port-accent-2" /> Daily rhythm (observed chronotype)
            </div>
            <DivergenceBadge comparison={evidence?.chronotypeComparison} />
          </div>
          <HourBars histogram={chronotype.histogram} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-gray-400">
            <div>Observed: <span className="text-white">{chronotype.observedType || '—'}</span></div>
            <div>Peak messages: <span className="text-white">{fmtHour(chronotype.peakHours?.messages)}</span></div>
            <div>Peak media: <span className="text-white">{fmtHour(chronotype.peakHours?.media)}</span></div>
            <div>Peak overall: <span className="text-white">{fmtHour(chronotype.peakHours?.overall)}</span></div>
          </div>
          {evidence?.statedChronotype?.type && (
            <div className="text-xs text-gray-500">
              Stated (genome/behavioral): <span className="text-gray-300">{evidence.statedChronotype.type}</span>
              {evidence.statedChronotype.confidence != null && ` (${Math.round(evidence.statedChronotype.confidence * 100)}% confidence)`}
            </div>
          )}
        </div>
      )}

      {/* Explicit AI interpretation — names the provider before running (AI policy). */}
      {hasEvidence && (
        <div className="border-t border-port-border pt-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1">
              <label htmlFor="twin-interpret-provider" className="block text-xs text-gray-500 mb-1">
                Interpret with AI provider
              </label>
              {providers.length === 0 ? (
                <p className="text-xs text-gray-500">No AI provider configured — add one in AI Providers.</p>
              ) : (
                <select
                  id="twin-interpret-provider"
                  value={selected?.providerId || ''}
                  onChange={(e) => {
                    const p = providers.find((x) => x.id === e.target.value);
                    setSelected({ providerId: e.target.value, model: p?.defaultModel || '' });
                  }}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white focus:outline-hidden focus:border-port-accent"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name || p.id}{p.defaultModel ? ` · ${p.defaultModel}` : ''}</option>
                  ))}
                </select>
              )}
            </div>
            <button
              onClick={handleInterpret}
              disabled={interpreting || providers.length === 0}
              className="flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
              title={selectedProvider ? `Runs ${selectedProvider.name || selectedProvider.id}` : undefined}
            >
              {interpreting ? <BrailleSpinner /> : <Sparkles size={15} />}
              What does this say about me?
            </button>
          </div>

          {interpretation?.text && (
            <div className="bg-port-bg rounded-lg border border-port-accent-2/30 p-4">
              <div className="text-sm"><MarkdownOutput content={interpretation.text} /></div>
              <div className="text-xs text-gray-500 mt-2">
                {interpretation.providerName || interpretation.provider}
                {interpretation.model ? ` · ${interpretation.model}` : ''}
                {interpretation.generatedAt ? ` · ${new Date(interpretation.generatedAt).toLocaleString()}` : ''}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
