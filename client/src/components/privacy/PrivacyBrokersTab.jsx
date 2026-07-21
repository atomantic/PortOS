import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search, ShieldOff, RefreshCw, CalendarClock, AlertTriangle,
  CheckCircle2, XCircle, ExternalLink, Loader2, Database, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  getPrivacyScanStatus, getPrivacyBrokerCases, getPrivacyBrokers, getPrivacyOptOutDigest,
  getPrivacyOptOutSchedule, updatePrivacyOptOutSchedule, runPrivacyScan, runPrivacyOptOut,
  refreshPrivacyBrokers, recheckPrivacyCase, transitionPrivacyCase, setPrivacyBrokerEnabled,
} from '../../services/api';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import toast from '../ui/Toast';
import { timeAgo, formatDateShort } from '../../utils/formatters';
import BrokerCaseDrawer from './BrokerCaseDrawer';
import {
  CASE_STATES, CASE_STATE_TONE, EXPOSURE_MAP_STATES, BROKER_SOURCES, BROKER_CONFIDENCE,
  ACTION_TONES, manualCaseActions, labelFor,
} from './constants';
import { isHttpUrl } from '../../utils/urlNormalize';

// Digest action icon by descriptor `icon` token (positive resolution vs dismiss).
const ACTION_ICONS = { check: CheckCircle2, x: XCircle };

// Stat chip for the exposure-map header.
function StatChip({ label, count, tone }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${tone || 'border-port-border'}`}>
      <span className="text-lg font-bold leading-none">{count}</span>
      <span className="text-[11px] uppercase tracking-wide opacity-80">{label}</span>
    </div>
  );
}

export default function PrivacyBrokersTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const openCaseId = searchParams.get('case');

  const [scanStatus, setScanStatus] = useState(null);
  const [cases, setCases] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [digest, setDigest] = useState({ total: 0, humanTasks: 0, blocked: 0, items: [] });
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState('');
  const [cronDraft, setCronDraft] = useState('');
  const [brokerListOpen, setBrokerListOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      getPrivacyScanStatus(), getPrivacyBrokerCases(), getPrivacyBrokers(),
      getPrivacyOptOutDigest(), getPrivacyOptOutSchedule(),
    ]).then(([s, c, b, d, sch]) => {
      setScanStatus(s.status === 'fulfilled' ? s.value : { enabledBrokers: 0, caseCounts: {}, dueForRecheck: 0 });
      setCases(c.status === 'fulfilled' ? c.value : []);
      setBrokers(b.status === 'fulfilled' ? b.value : []);
      setDigest(d.status === 'fulfilled' ? d.value : { total: 0, humanTasks: 0, blocked: 0, items: [] });
      const schVal = sch.status === 'fulfilled' ? sch.value : null;
      setSchedule(schVal);
      if (schVal) setCronDraft(schVal.cronExpression || '');
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const brokerById = useMemo(() => new Map(brokers.map((b) => [b.id, b])), [brokers]);
  const caseCounts = scanStatus?.caseCounts || {};
  const lastActivity = useMemo(() => {
    const times = cases.map((c) => c.updatedAt).filter(Boolean).sort();
    return times.length ? times[times.length - 1] : null;
  }, [cases]);

  const visibleCases = stateFilter ? cases.filter((c) => c.state === stateFilter) : cases;
  const openCase = openCaseId ? cases.find((c) => c.id === openCaseId) : null;

  // ── Run controls (synchronous passes — gate both while either runs) ─────────
  const [scanNow, scanRunning] = useAsyncAction(async () => {
    const r = await runPrivacyScan({ silent: true });
    load();
    const verdicts = Object.entries(r?.verdicts || {}).map(([k, v]) => `${v} ${labelFor(CASE_STATES, k).toLowerCase()}`).join(', ');
    toast.success(r?.reason === 'no_scan_vectors'
      ? 'Add a name to the vault (scan-eligible) to run a scan'
      : `Scan complete: ${r?.scanned || 0} verdicts${verdicts ? ` (${verdicts})` : ''}`);
    return r;
  }, { errorMessage: 'Scan failed' });

  const [optOutNow, optOutRunning] = useAsyncAction(async () => {
    const r = await runPrivacyOptOut({ silent: true });
    load();
    toast.success(r?.reason === 'no_disclosure_identity'
      ? 'Add a scan-eligible name to the vault to run an opt-out pass'
      : `Opt-out pass: ${r?.submitted?.length || 0} actioned, ${r?.skipped || 0} skipped`);
    return r;
  }, { errorMessage: 'Opt-out pass failed' });

  const [refreshList, refreshing] = useAsyncAction(async () => {
    const r = await refreshPrivacyBrokers({ silent: true });
    load();
    toast.success(`Broker list refreshed: ${r?.added || 0} new (${r?.fetched || 0} fetched)`);
    return r;
  }, { errorMessage: 'Broker refresh failed' });

  const passRunning = scanRunning || optOutRunning;

  // ── Schedule / autonomy toggles (persist immediately, restart the cron) ─────
  const [saveSchedule, scheduleSaving] = useAsyncAction(async (patch) => {
    const next = await updatePrivacyOptOutSchedule(patch, { silent: true });
    setSchedule(next);
    if (next?.cronExpression) setCronDraft(next.cronExpression);
    return next;
  }, { errorMessage: 'Failed to update schedule' });

  const toggleEnabled = async () => {
    const next = await saveSchedule({ enabled: !schedule.enabled });
    if (next) toast.success(next.enabled ? `Recheck scheduled (${next.cronExpression})` : 'Recheck schedule disabled');
  };
  const toggleAutoApprove = async () => {
    const next = await saveSchedule({ autoApproveOptOutEmails: !schedule.autoApproveOptOutEmails });
    if (next) toast.success(next.autoApproveOptOutEmails ? 'Auto-approve opt-out emails ON' : 'Auto-approve opt-out emails OFF');
  };
  const saveCron = async () => {
    const next = await saveSchedule({ cronExpression: cronDraft.trim() });
    if (next) toast.success(`Schedule set to "${next.cronExpression}"`);
  };
  const cronDirty = schedule && cronDraft.trim() !== (schedule.cronExpression || '');

  // ── Case controls ───────────────────────────────────────────────────────────
  const [caseBusy, setCaseBusy] = useState(false);
  const doRecheck = async (kase) => {
    setCaseBusy(true);
    const r = await recheckPrivacyCase(kase.id, { silent: true }).catch(() => null);
    setCaseBusy(false);
    if (r) { toast.success('Case queued for re-check'); load(); }
    else toast.error('Failed to queue re-check');
  };
  const doTransition = async (kase, toState) => {
    setCaseBusy(true);
    const r = await transitionPrivacyCase(kase.id, toState, undefined, { silent: true }).catch(() => null);
    setCaseBusy(false);
    if (r) { toast.success(`Case → ${labelFor(CASE_STATES, toState)}`); load(); }
    else toast.error('Transition not allowed');
  };

  const openDrawer = (id) => { searchParams.set('case', id); setSearchParams(searchParams, { replace: false }); };
  const closeDrawer = () => { searchParams.delete('case'); setSearchParams(searchParams, { replace: false }); };

  // ── Broker enable/disable ─────────────────────────────────────────────────
  const toggleBroker = async (broker) => {
    const updated = await setPrivacyBrokerEnabled(broker.id, !broker.enabled, { silent: true }).catch(() => null);
    if (updated) setBrokers((prev) => prev.map((b) => (b.id === broker.id ? updated : b)));
    else toast.error('Failed to toggle broker');
  };

  if (loading) return <div className="text-gray-500 text-sm py-8 text-center">Loading broker exposure…</div>;

  return (
    <div className="space-y-6">
      {/* ── Exposure map header ── */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-semibold text-white">Exposure map</h2>
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>{scanStatus?.enabledBrokers || 0} brokers enabled</span>
            <span>{scanStatus?.dueForRecheck || 0} due for re-check</span>
            {lastActivity && <span>Last activity {timeAgo(lastActivity)}</span>}
            {schedule?.enabled && schedule.nextRun && (
              <span className="inline-flex items-center gap-1"><CalendarClock size={12} /> Next run {formatDateShort(schedule.nextRun)}</span>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {EXPOSURE_MAP_STATES.map((st) => (
            <StatChip key={st} label={labelFor(CASE_STATES, st)} count={caseCounts[st] || 0} tone={CASE_STATE_TONE[st]} />
          ))}
        </div>
      </section>

      {/* ── Run controls ── */}
      <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
        <h2 className="text-sm font-semibold text-white">Run controls</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => scanNow()}
            disabled={passRunning}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50"
          >
            {scanRunning ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {scanRunning ? 'Scanning…' : 'Scan now'}
          </button>
          <button
            onClick={() => optOutNow()}
            disabled={passRunning}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-port-border text-gray-200 hover:text-white hover:bg-port-border/40 disabled:opacity-50"
          >
            {optOutRunning ? <Loader2 size={16} className="animate-spin" /> : <ShieldOff size={16} />}
            {optOutRunning ? 'Running…' : 'Run opt-out pass'}
          </button>
        </div>

        {/* Schedule + autonomy */}
        {schedule && (
          <div className="space-y-3 border-t border-port-border pt-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                id="privacy-recheck-enabled"
                type="checkbox"
                checked={schedule.enabled}
                onChange={toggleEnabled}
                disabled={scheduleSaving}
                className="accent-port-accent"
              />
              <span className="text-sm text-gray-200">Automatic recheck schedule</span>
              {schedule.enabled && (
                <span className="text-[11px] text-gray-500">runs a scan + opt-out pass on the cron below</span>
              )}
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="privacy-recheck-cron" className="text-[11px] uppercase tracking-wide text-gray-500">Cron</label>
              <input
                id="privacy-recheck-cron"
                type="text"
                value={cronDraft}
                onChange={(e) => setCronDraft(e.target.value)}
                placeholder="0 4 * * 0"
                className="px-2 py-1 text-sm rounded bg-port-bg border border-port-border text-gray-200 font-mono w-36"
              />
              <button
                onClick={saveCron}
                disabled={!cronDirty || scheduleSaving}
                className="px-2.5 py-1 text-xs rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-border/40 disabled:opacity-40"
              >
                Save cron
              </button>
              <span className="text-[11px] text-gray-600">min hour dom month dow</span>
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                id="privacy-auto-approve"
                type="checkbox"
                checked={schedule.autoApproveOptOutEmails}
                onChange={toggleAutoApprove}
                disabled={scheduleSaving}
                className="accent-port-accent"
              />
              <span className="text-sm text-gray-200">Auto-approve opt-out emails</span>
              <span className="text-[11px] text-gray-500">standing authorization — off means each draft waits for approval in Comms</span>
            </label>
          </div>
        )}
      </section>

      {/* ── Human-task digest ── */}
      {digest.total > 0 && (
        <section className="bg-port-warning/5 border border-port-warning/30 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-port-warning" />
            <h2 className="text-sm font-semibold text-white">Human tasks ({digest.total})</h2>
            <span className="text-[11px] text-gray-500">{digest.humanTasks} manual · {digest.blocked} blocked</span>
          </div>
          <div className="space-y-2">
            {digest.items.map((item) => (
              <div key={item.caseId} className="flex flex-wrap items-center justify-between gap-2 bg-port-card border border-port-border rounded p-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-white truncate">{item.brokerName || item.brokerId}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${CASE_STATE_TONE[item.state] || ''}`}>
                      {labelFor(CASE_STATES, item.state)}
                    </span>
                  </div>
                  {item.reason && <div className="text-[11px] text-gray-500 mt-0.5">{item.reason}{item.channel ? ` · ${item.channel}` : ''}</div>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {item.state === 'blocked' && item.searchUrl && isHttpUrl(item.searchUrl) && (
                    <a href={item.searchUrl} target="_blank" rel="noreferrer" title="Check manually in your browser" aria-label="Check manually in your browser" className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50">
                      <Search size={15} />
                    </a>
                  )}
                  {item.optoutUrl && isHttpUrl(item.optoutUrl) && (
                    <a href={item.optoutUrl} target="_blank" rel="noreferrer" title="Open opt-out page" aria-label="Open opt-out page" className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50">
                      <ExternalLink size={15} />
                    </a>
                  )}
                  {manualCaseActions(item.state, item.allowedTransitions).map((action) => {
                    const Icon = ACTION_ICONS[action.icon] || CheckCircle2;
                    return (
                      <button key={action.target} onClick={() => doTransition({ id: item.caseId }, action.target)} disabled={caseBusy} title={action.label} aria-label={action.label} className={`p-1.5 rounded ${ACTION_TONES[action.tone]?.chip || ''} disabled:opacity-50`}>
                        <Icon size={15} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Case board ── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-white">Case board</h2>
          <div className="flex items-center gap-2">
            <label htmlFor="privacy-case-filter" className="text-[11px] uppercase tracking-wide text-gray-500">State</label>
            <select
              id="privacy-case-filter"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="px-2 py-1 text-sm rounded bg-port-bg border border-port-border text-gray-200"
            >
              <option value="">All ({cases.length})</option>
              {CASE_STATES.filter((s) => caseCounts[s.id]).map((s) => (
                <option key={s.id} value={s.id}>{s.label} ({caseCounts[s.id]})</option>
              ))}
            </select>
          </div>
        </div>

        {visibleCases.length === 0 ? (
          <div className="border border-dashed border-port-border rounded-lg p-8 text-center text-gray-500 text-sm">
            {cases.length === 0 ? 'No cases yet. Run a scan to check your exposure across data brokers.' : 'No cases match this filter.'}
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleCases.map((c) => {
              const broker = brokerById.get(c.brokerId);
              const listingCount = Array.isArray(c.evidence?.listing_urls) ? c.evidence.listing_urls.length : 0;
              return (
                <button
                  key={c.id}
                  onClick={() => openDrawer(c.id)}
                  className="w-full text-left bg-port-card border border-port-border rounded-lg p-3 hover:border-port-accent/50 transition-colors"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${CASE_STATE_TONE[c.state] || ''}`}>
                      {labelFor(CASE_STATES, c.state)}
                    </span>
                    <span className="text-sm text-white truncate flex-1 min-w-0">{c.brokerName || c.brokerId}</span>
                    {broker?.clusterParent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-accent/30 text-port-accent">cluster child</span>
                    )}
                    {c.brokerTier !== undefined && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-500">T{c.brokerTier}</span>
                    )}
                    {listingCount > 0 && (
                      <span className="text-[10px] text-gray-500">{listingCount} listing{listingCount > 1 ? 's' : ''}</span>
                    )}
                    {c.nextRecheckAt && (
                      <span className="text-[10px] text-gray-500">recheck {formatDateShort(c.nextRecheckAt)}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Broker database ── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            onClick={() => setBrokerListOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-white"
          >
            {brokerListOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <Database size={15} className="text-gray-500" /> Broker database ({brokers.length})
          </button>
          <button
            onClick={() => refreshList()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-border/40 disabled:opacity-50"
          >
            {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh broker list
          </button>
        </div>
        {brokerListOpen && (
          <div className="space-y-1.5">
            {brokers.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 bg-port-card border border-port-border rounded-lg p-2.5">
                <div className="min-w-0 flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-white truncate">{b.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-500">T{b.tier}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-500">{labelFor(BROKER_SOURCES, b.source)}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-500">{labelFor(BROKER_CONFIDENCE, b.confidence)}</span>
                  {b.clusterParent && <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-accent/30 text-port-accent">child of {b.clusterParent}</span>}
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0">
                  <input type="checkbox" checked={b.enabled} onChange={() => toggleBroker(b)} className="accent-port-accent" aria-label={`Enable ${b.name}`} />
                  <span className="text-[11px] text-gray-400">{b.enabled ? 'Enabled' : 'Disabled'}</span>
                </label>
              </div>
            ))}
          </div>
        )}
      </section>

      <BrokerCaseDrawer
        open={!!openCaseId}
        caseData={openCase}
        broker={openCase ? brokerById.get(openCase.brokerId) : null}
        onClose={closeDrawer}
        onRecheck={doRecheck}
        onTransition={doTransition}
        busy={caseBusy}
      />
    </div>
  );
}
