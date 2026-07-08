import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Brain, Settings, Clock, CheckCircle2, PauseCircle, Sparkles } from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import Banner from '../components/ui/Banner';
import * as api from '../services/api';
import { timeAgo, timeUntil } from '../utils/formatters';
import {
  LI_SCOPES,
  LI_SOURCE_FIELDS,
  LI_INTERVAL_PRESETS
} from '../components/apps/LayeredIntelligenceTab';

// Label lookups reused from the per-app config tab so the page and the drawer
// never drift on scope/source/interval naming.
const SCOPE_LABEL = Object.fromEntries(LI_SCOPES.map(s => [s.id, s.label]));
const SOURCE_LABEL = Object.fromEntries(LI_SOURCE_FIELDS.map(s => [s.key, s.label]));
const INTERVAL_LABEL = Object.fromEntries(LI_INTERVAL_PRESETS.map(p => [p.ms, p.label]));

// Human interval: a known preset renders as its label ("Daily"), else "every N min".
function intervalLabel(ms) {
  if (INTERVAL_LABEL[ms]) return INTERVAL_LABEL[ms];
  if (!ms) return '-';
  return `every ${Math.round(ms / 60000)} min`;
}

// The enabled telemetry sources for an app as short chip labels (+ custom count).
function sourceChips(sources = {}) {
  const chips = LI_SOURCE_FIELDS.filter(f => sources[f.key]).map(f => SOURCE_LABEL[f.key]);
  if (sources.customCount > 0) chips.push(`${sources.customCount} custom`);
  return chips;
}

function Chip({ children, tone = 'default' }) {
  const tones = {
    default: 'bg-port-bg text-gray-300 border-port-border',
    accent: 'bg-port-accent/15 text-port-accent border-port-accent/30',
    success: 'bg-port-success/15 text-port-success border-port-success/30',
    warning: 'bg-port-warning/15 text-port-warning border-port-warning/30'
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-xs ${tones[tone] || tones.default}`}>
      {children}
    </span>
  );
}

function AppLoopCard({ app }) {
  const scopes = (app.allowedScopes || []).map(id => SCOPE_LABEL[id] || id);
  const chips = sourceChips(app.sources);
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link to={`/apps/${app.id}`} className="font-medium text-white hover:underline truncate">
              {app.name}
            </Link>
            {app.isPortos && <Chip tone="accent">PortOS</Chip>}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            {app.enabled
              ? <span className="flex items-center gap-1 text-port-success"><CheckCircle2 size={13} /> Enabled</span>
              : <span className="flex items-center gap-1 text-gray-500"><PauseCircle size={13} /> Disabled</span>}
            {app.enabled && app.due && <Chip tone="warning">Due now</Chip>}
          </div>
        </div>
        <Link
          to={`/apps/${app.id}?edit=1&appTab=intelligence`}
          className="flex items-center gap-1 text-xs px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded shrink-0"
        >
          <Settings size={12} /> Configure
        </Link>
      </div>

      {app.enabled && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div>
            <div className="text-gray-500">Interval</div>
            <div className="text-gray-300 flex items-center gap-1"><Clock size={11} /> {intervalLabel(app.intervalMs)}</div>
          </div>
          <div>
            <div className="text-gray-500">Last run</div>
            <div className="text-gray-300">{timeAgo(app.lastRunAt)}</div>
          </div>
          <div>
            <div className="text-gray-500">Next due</div>
            <div className="text-gray-300">{app.due ? 'now' : (app.nextDueAt ? timeUntil(app.nextDueAt, 'soon') : 'first run')}</div>
          </div>
          <div>
            <div className="text-gray-500">Provider</div>
            <div className="text-gray-300 truncate">{app.providerId || 'default'}</div>
          </div>
        </div>
      )}

      {app.enabled && (
        <div className="flex flex-col gap-2">
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map(c => <Chip key={c}>{c}</Chip>)}
            </div>
          )}
          {scopes.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {scopes.map(s => <Chip key={s} tone="accent">{s}</Chip>)}
            </div>
          )}
          {app.hasRules && <div className="text-xs text-gray-500 flex items-center gap-1"><Sparkles size={11} /> Custom guidance rules set</div>}
        </div>
      )}
    </div>
  );
}

export default function LayeredIntelligence() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    const res = await api.getLayeredIntelligenceOverview({ silent: true }).catch(() => null);
    if (!res) setError(true);
    else setData(res);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const apps = data?.apps || [];
  const enabledApps = apps.filter(a => a.enabled);
  const availableApps = apps.filter(a => !a.enabled);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <Brain size={24} className="text-port-accent mt-0.5 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-white">Layered Intelligence</h1>
          <p className="text-sm text-gray-400">
            A perpetual, per-app self-improvement loop. On its schedule it reads each enabled app&apos;s goals and
            telemetry, asks a reasoning model for the single highest-value improvement, and files one deduplicated
            tracker issue for a coding agent — the model never touches code. Configure it per app on each app&apos;s
            Intelligence tab.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><BrailleSpinner text="Loading" /></div>
      ) : error ? (
        <div className="space-y-3">
          <Banner tone="error" size="md">Couldn&apos;t load the Layered Intelligence overview.</Banner>
          <button
            type="button"
            onClick={() => { setLoading(true); load(); }}
            className="text-xs px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {!data.jobEnabled && (
            <Banner tone="warning" size="md">
              The global <strong>Layered Intelligence Loop</strong> job is off, so no app&apos;s loop will run even when
              enabled below. Turn it on under{' '}
              <Link to="/cos/jobs" className="underline hover:text-white">Chief of Staff → System Tasks</Link>.
            </Banner>
          )}

          <div className="text-sm text-gray-400">
            {enabledApps.length} of {apps.length} app{apps.length === 1 ? '' : 's'} have the loop enabled.
          </div>

          {enabledApps.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {enabledApps.map(app => <AppLoopCard key={app.id} app={app} />)}
            </div>
          ) : (
            <Banner tone="info" size="md">
              No app has the loop enabled yet. Enable it per app on its Intelligence tab — it&apos;s off by default.
            </Banner>
          )}

          {availableApps.length > 0 && (
            <div className="space-y-2 pt-2">
              <h2 className="text-sm font-medium text-gray-400">Available apps ({availableApps.length})</h2>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                {availableApps.map(app => (
                  <Link
                    key={app.id}
                    to={`/apps/${app.id}?edit=1&appTab=intelligence`}
                    className="flex items-center justify-between gap-2 bg-port-card border border-port-border rounded-lg px-3 py-2 hover:border-port-accent/50"
                  >
                    <span className="text-sm text-gray-300 truncate">{app.name}</span>
                    <Settings size={13} className="text-gray-500 shrink-0" />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
