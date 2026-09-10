import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { getAppQualityHistory } from '../../services/apiApps';

export default function AppQualityHistory({ appId, categories = [] }) {
  const [params, setParams] = useSearchParams();
  const days = ['30', '90', '365'].includes(params.get('qualityDays')) ? params.get('qualityDays') : '90';
  const category = categories.some(c => c.id === params.get('qualityCategory')) ? params.get('qualityCategory') : 'overall';
  const [state, setState] = useState({ loading: true });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    getAppQualityHistory(appId, days).then(data => {
      if (active) setState({ data });
    }).catch(() => {
      if (active) setState({ error: true });
    });
    return () => { active = false; };
  }, [appId, days, refresh]);
  const change = (key, value) => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.set(key, value);
    return next;
  });
  const points = (state.data?.points || []).map(point => ({ ...point,
    value: category === 'overall' ? point.score : point.categories[category]?.score ?? null,
    evidence: category === 'overall' ? `${point.ratedCategories}/${state.data.totalCategories} categories` :
      `${point.categories[category]?.coverage ?? 'unavailable'} · ${point.categories[category]?.confidence ?? 'unknown'} confidence`,
  }));
  const measured = points.filter(p => p.value !== null);
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">Quality over time</h4>
      <div className="flex flex-wrap gap-3 text-sm">
        <label htmlFor="quality-period">Period <select id="quality-period" className="bg-port-bg border border-port-border rounded p-1" value={days} onChange={e => change('qualityDays', e.target.value)}>
          <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option>
        </select></label>
        <label htmlFor="quality-history-category" className="min-w-0">Category <select id="quality-history-category" className="bg-port-bg border border-port-border rounded p-1 max-w-full" value={category} onChange={e => change('qualityCategory', e.target.value)}>
          <option value="overall">Overall</option>{categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select></label>
        <button type="button" className="text-port-accent hover:underline" onClick={() => setRefresh(n => n + 1)}>Refresh history</button>
      </div>
      <p className="text-xs text-gray-400">Daily snapshots (UTC), higher is healthier. Scores carry forward for up to 30 days; gaps mean no fresh evidence. Coverage changes can move the overall mean. Category views include provisional assessments.</p>
      {state.data?.federation && <p className="text-xs text-gray-400">Unified history includes {state.data.federation.available ?? 0} available full-sync peers. {state.data.federation.failed ? 'Peer quality could not be loaded; history may be incomplete.' : state.data.federation.unavailable > 0 ? `${state.data.federation.unavailable} peers unavailable or incompatible; history may be incomplete.` : 'Peer availability can change historical coverage.'}</p>}
      {state.loading ? <p role="status">Loading quality history…</p> : state.error ? <p role="alert">Quality history could not be loaded. Use Refresh history to retry.</p> : !measured.length ? <p className="text-sm text-gray-400">No scored assessments in this period. Run an audit to start the history.</p> : <>
        <div className="h-48 w-full" role="img" aria-label="Daily quality scores from 0 to 100; values and evidence are available in the history table below">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 11 }} minTickGap={40} />
              <YAxis domain={[0, 100]} tick={{ fill: '#9ca3af', fontSize: 11 }} width={35} />
              <Tooltip contentStyle={{ backgroundColor: '#111827', borderColor: '#374151' }} formatter={(value, _name, item) => [`${value}/100 · ${item.payload.evidence}`, 'Quality']} />
              <Line type="stepAfter" dataKey="value" name="Quality" stroke="#60a5fa" strokeWidth={2} connectNulls={false} dot={measured.length === 1} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <details><summary className="cursor-pointer text-sm text-port-accent">History values and coverage</summary>
          <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs">
            <thead><tr><th>Date (UTC)</th><th>Score</th><th>Evidence</th></tr></thead>
            <tbody>{points.map(point => <tr key={point.date}><th scope="row" className="py-1 font-normal">{point.date}</th><td>{point.value == null ? '—' : `${point.value}/100`}</td><td>{point.evidence}</td></tr>)}</tbody>
          </table></div>
        </details>
      </>}
    </div>
  );
}
