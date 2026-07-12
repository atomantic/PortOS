import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Bot, CalendarDays, ChevronRight, Clock3, GitBranch, Infinity as InfinityIcon, RefreshCw, RotateCcw, TimerReset, Workflow } from 'lucide-react';
import * as api from '../../../services/api';
import { useAppOverrideActions } from '../../../hooks/useAppOverrideActions';
import { describeCron } from '../../../utils/cronHelpers';
import ScheduleEditor from './workflow/ScheduleEditor';
import PerAppOverrideList from './schedule/PerAppOverrideList';

const TRACK_COLORS = {
  cron: { marker: 'bg-purple-400', text: 'text-purple-300', wash: 'bg-purple-500/10' },
  perpetual: { marker: 'bg-amber-400', text: 'text-amber-300', wash: 'bg-amber-500/10' },
  job: { marker: 'bg-cyan-400', text: 'text-cyan-300', wash: 'bg-cyan-500/10' },
  task: { marker: 'bg-emerald-400', text: 'text-emerald-300', wash: 'bg-emerald-500/10' }
};

function trackPalette(node) {
  if (node.schedule?.type === 'perpetual') return TRACK_COLORS.perpetual;
  if (node.schedule?.cronExpression) return TRACK_COLORS.cron;
  return TRACK_COLORS[node.kind] || TRACK_COLORS.task;
}

function describeSchedule(node) {
  const schedule = node.schedule || {};
  if (schedule.type === 'perpetual') {
    const reset = schedule.recheckCron ? describeCron(schedule.recheckCron) : 'daily reset';
    return `perpetual · ${reset}`;
  }
  if (schedule.cronExpression) return describeCron(schedule.cronExpression) || schedule.cronExpression;
  if (node.kind === 'job' && schedule.scheduledTime) return `${schedule.type} at ${schedule.scheduledTime}`;
  if (schedule.type === 'custom' && schedule.intervalMs) {
    const intervalHours = schedule.intervalMs / 3_600_000;
    if (intervalHours >= 24) return `every ${Math.round(intervalHours / 24)}d`;
    if (intervalHours >= 1) return `every ${Math.round(intervalHours)}h`;
    return `every ${Math.round(schedule.intervalMs / 60_000)}m`;
  }
  return schedule.type?.replaceAll('-', ' ') || 'flexible';
}

function formatPoint(iso, hours, timezone) {
  const date = new Date(iso);
  const options = { hour: 'numeric', minute: '2-digit', timeZone: timezone };
  return hours === 168
    ? date.toLocaleString([], { ...options, weekday: 'short' })
    : date.toLocaleTimeString([], options);
}

function relativeTime(iso) {
  const deltaMinutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  if (deltaMinutes < 60) return deltaMinutes === 0 ? 'now' : `in ${deltaMinutes}m`;
  if (deltaMinutes < 1440) return `in ${Math.round(deltaMinutes / 60)}h`;
  return `in ${Math.round(deltaMinutes / 1440)}d`;
}

// A launch tagged `dueNow` fires because the scheduler already considers the
// task due — a catch-up, first run, or elapsed interval — not because a cadence
// slot lands now. Explain why, so a NOW marker beside "Sun at 07:00" doesn't
// read as a bug. Returns null for ordinary on-cadence launches.
function dueNowMeta(occurrence, node, timezone) {
  if (!occurrence?.dueNow) return null;
  const reason = occurrence.reason || '';
  if (reason.startsWith('cron-catch-up')) {
    const slot = occurrence.missedSlot
      ? new Date(occurrence.missedSlot).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: timezone })
      : null;
    return { badge: 'catch-up', detail: slot ? `Catch-up for the missed ${slot} slot` : 'Catch-up for a missed slot' };
  }
  if (reason === 'once-first-run' || !node?.lastRun) {
    return { badge: 'first run', detail: 'First run — has never run before' };
  }
  return { badge: 'overdue', detail: 'Overdue — the interval elapsed since the last run' };
}

function timelinePercent(iso, timeline) {
  const start = new Date(timeline.startAt).getTime();
  const end = new Date(timeline.endAt).getTime();
  return Math.max(0, Math.min(100, ((new Date(iso).getTime() - start) / (end - start)) * 100));
}

function Axis({ timeline, hours, timezone }) {
  const divisions = hours === 168 ? 7 : 8;
  const start = new Date(timeline.startAt).getTime();
  const end = new Date(timeline.endAt).getTime();
  return (
    <div className="relative h-9 border-b border-port-border/60 text-[10px] text-gray-500">
      {Array.from({ length: divisions + 1 }, (_, index) => {
        const at = new Date(start + ((end - start) * index) / divisions);
        return (
          <div key={index} className="absolute bottom-1 -translate-x-1/2 whitespace-nowrap" style={{ left: `${(index / divisions) * 100}%` }}>
            {index === 0 ? 'Now' : hours === 168 ? at.toLocaleDateString([], { weekday: 'short', timeZone: timezone }) : `+${index * 3}h`}
          </div>
        );
      })}
    </div>
  );
}

function TrackGrid({ divisions }) {
  return Array.from({ length: divisions + 1 }, (_, index) => (
    <span key={index} className="pointer-events-none absolute inset-y-0 border-l border-port-border/25" style={{ left: `${(index / divisions) * 100}%` }} />
  ));
}

// Reshapes a task node into the `config` shape PerAppOverrideList expects and
// renders it. Shared by the pinned TimelineRow and the flexible-queue rows so
// the config reconstruction lives in exactly one place.
function AppOverridePanel({ node, apps, onUpdateOverride, onBulkToggleOverride }) {
  return (
    <PerAppOverrideList
      taskType={node.label}
      config={{
        appOverrides: node.appOverrides,
        type: node.schedule?.type,
        taskMetadata: node.taskMetadata,
        managedAgentOptions: node.managedAgentOptions
      }}
      apps={apps}
      onUpdateOverride={onUpdateOverride}
      onBulkToggleOverride={onBulkToggleOverride}
    />
  );
}

function TimelineRow({ node, occurrences, windows, timeline, hours, timezone, selected, apps, expanded, onSelect, onToggleExpand, onUpdateOverride, onBulkToggleOverride }) {
  const palette = trackPalette(node);
  const Icon = node.kind === 'job' ? Bot : GitBranch;
  const divisions = hours === 168 ? 7 : 8;
  const dependencyWarning = node.pendingDeps?.length > 0;

  // App overrides only apply to task types (system jobs are not per-app). The
  // server's active-app counts drive the toggle + badge (single source of
  // truth); PerAppOverrideList does its own `apps` filtering when expanded.
  const { enabledAppCount = 0, totalAppCount = 0 } = node;
  const canExpand = node.kind === 'task' && totalAppCount > 0;
  const countTitle = `${enabledAppCount} of ${totalAppCount} apps enabled`;

  return (
    <div className={`border-b border-port-border/40 transition-colors last:border-b-0 ${selected ? 'bg-port-accent/8' : ''}`}>
      <div className={`grid w-full grid-cols-[14rem_minmax(42rem,1fr)] ${selected ? '' : 'hover:bg-white/[0.025]'}`}>
        <div className="flex min-w-0 items-center gap-1.5 border-r border-port-border/50 px-3 py-2.5">
          {canExpand ? (
            <button
              type="button"
              onClick={() => onToggleExpand(node.id)}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} app overrides for ${node.label}`}
              title={countTitle}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-white/10 hover:text-gray-300"
            >
              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </button>
          ) : (
            <span className="h-5 w-5 shrink-0" aria-hidden="true" />
          )}
          <button type="button" onClick={() => onSelect(node.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${palette.wash} ${palette.text}`}><Icon className="h-3.5 w-3.5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-gray-200" title={node.label}>{node.label}</span>
              <span className="mt-0.5 block truncate text-[10px] text-gray-500">{describeSchedule(node)}</span>
            </span>
          </button>
          {canExpand && (
            <span className={`shrink-0 rounded-sm px-1 py-px text-[9px] font-medium ${enabledAppCount > 0 ? 'bg-port-accent/15 text-port-accent' : 'bg-white/5 text-gray-500'}`} title={countTitle}>
              {enabledAppCount}/{totalAppCount}
            </span>
          )}
          {dependencyWarning && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-port-warning" />}
        </div>
        <button type="button" onClick={() => onSelect(node.id)} className="relative block min-h-12 overflow-hidden text-left">
          <TrackGrid divisions={divisions} />
          <span className="absolute inset-y-0 left-0 z-10 border-l border-port-accent/70" />
          {windows.map(window => (
            <span
              key={window.id}
              className="absolute inset-y-2 rounded border border-amber-400/40 bg-gradient-to-r from-amber-500/30 via-amber-400/15 to-amber-500/5"
              style={{ left: `${timelinePercent(window.startAt, timeline)}%`, right: `${100 - timelinePercent(window.endAt, timeline)}%` }}
              title="Actively draining work; duration depends on the backlog"
            >
              <span className="absolute left-2 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-medium text-amber-200"><InfinityIcon className="mr-1 inline h-3 w-3" />draining</span>
            </span>
          ))}
          {occurrences.map(occurrence => {
            const meta = dueNowMeta(occurrence, node, timezone);
            // Due-now is an amber FILL, collision a warning RING — kept on separate
            // channels so a launch that is BOTH (the common catch-up scenario, where
            // several tasks are due at Now and therefore also collide) shows both
            // states at once. A shared ring channel would let collision mask due-now.
            const fill = occurrence.kind === 'recheck' ? 'rotate-45 bg-amber-300' : meta ? 'bg-amber-400' : palette.marker;
            const ring = occurrence.collision ? 'ring-2 ring-port-warning ring-offset-1 ring-offset-port-bg' : '';
            return (
              <span
                key={occurrence.id}
                className={`absolute top-1/2 z-20 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-port-bg shadow ${fill} ${ring}`}
                style={{ left: `${timelinePercent(occurrence.at, timeline)}%` }}
                title={`${occurrence.kind === 'recheck' ? 'Reset/recheck' : 'Launch'} ${formatPoint(occurrence.at, hours, timezone)}${meta ? ` · ${meta.detail}` : ''}${occurrence.collision ? ' · another task launches within 15 minutes' : ''}`}
              />
            );
          })}
        </button>
      </div>
      {canExpand && expanded && (
        <div className="border-t border-port-border/40 bg-port-bg/20 px-3 py-3">
          <AppOverridePanel node={node} apps={apps} onUpdateOverride={onUpdateOverride} onBulkToggleOverride={onBulkToggleOverride} />
        </div>
      )}
    </div>
  );
}

function NextUp({ occurrences, nodeMap, hours, timezone, onSelect }) {
  const next = occurrences.slice(0, 8);
  if (next.length === 0) return null;
  return (
    <section className="rounded-lg border border-port-border/60 bg-port-card/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-gray-500">
        <Clock3 className="h-3.5 w-3.5" /> Scheduled order
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {next.map((occurrence, index) => {
          const node = nodeMap.get(occurrence.nodeId);
          if (!node) return null;
          const meta = dueNowMeta(occurrence, node, timezone);
          return (
            <div key={occurrence.id} className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => onSelect(node.id)} title={meta?.detail || undefined} className={`min-w-36 rounded border px-3 py-2 text-left hover:border-port-accent/50 ${occurrence.collision ? 'border-port-warning/50 bg-port-warning/5' : meta ? 'border-amber-400/50 bg-amber-500/5' : 'border-port-border bg-port-bg/50'}`}>
                <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                  <span>{formatPoint(occurrence.at, hours, timezone)} · {relativeTime(occurrence.at)}</span>
                  {meta && <span className="rounded-sm bg-amber-500/15 px-1 py-px text-[9px] text-amber-300">{meta.badge}</span>}
                </span>
                <span className="mt-0.5 block max-w-44 truncate text-xs text-gray-200">{occurrence.kind === 'recheck' ? '↻ ' : ''}{node.label}</span>
              </button>
              {index < next.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-gray-700" />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function WorkflowTab({ apps }) {
  // Zoom window + selected track live in the URL so the open editor and view
  // are shareable/bookmarkable and survive reload — the same "URL is the
  // source of truth for what's open" convention as ScheduleTab's ?task=.
  const [searchParams, setSearchParams] = useSearchParams();
  const hoursParam = Number.parseInt(searchParams.get('hours'), 10);
  const hours = [24, 168].includes(hoursParam) ? hoursParam : 24;
  const setHours = useCallback((next) => {
    const params = new URLSearchParams(searchParams);
    if (next === 24) params.delete('hours');
    else params.set('hours', String(next));
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const selectedId = searchParams.get('track');
  const setSelectedId = useCallback((next) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('track', next);
    else params.delete('track');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Which task rows have their per-app override panel expanded. Kept as local
  // view state (a lightweight detail, not a selected record) rather than in the
  // URL — the ?track= param already owns the selected editor panel.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const fetchGeneration = useRef(0);

  const toggleExpand = useCallback((id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const fetchGraph = useCallback(async () => {
    const generation = ++fetchGeneration.current;
    setLoading(true);
    const data = await api.getCosWorkflow(hours).catch(err => {
      if (generation === fetchGeneration.current) setError(err?.message || 'Failed to load schedule');
      return null;
    });
    if (data && generation === fetchGeneration.current) {
      setGraph(data);
      setError(null);
    }
    if (generation === fetchGeneration.current) setLoading(false);
  }, [hours]);

  useEffect(() => {
    fetchGraph();
    return () => { fetchGeneration.current += 1; };
  }, [fetchGraph]);

  // Per-app override mutations are shared with ScheduleTab; refetch the graph so
  // the enabled-app counts and inherited defaults stay in sync after each change.
  const { handleUpdateOverride, handleBulkToggleOverride } = useAppOverrideActions(apps, fetchGraph);

  const model = useMemo(() => {
    if (!graph?.timeline) return null;
    const nodeMap = new Map(graph.nodes.map(node => [node.id, node]));
    const occurrencesByNode = new Map();
    const windowsByNode = new Map();
    for (const occurrence of graph.timeline.occurrences) {
      if (!occurrencesByNode.has(occurrence.nodeId)) occurrencesByNode.set(occurrence.nodeId, []);
      occurrencesByNode.get(occurrence.nodeId).push(occurrence);
    }
    for (const window of graph.timeline.windows) {
      if (!windowsByNode.has(window.nodeId)) windowsByNode.set(window.nodeId, []);
      windowsByNode.get(window.nodeId).push(window);
    }
    const isFlexible = node => node.kind === 'task' && ['rotation', 'on-demand'].includes(node.schedule?.type);
    const scheduled = graph.nodes
      .filter(node => node.enabled && !isFlexible(node))
      .sort((a, b) => {
        const aAt = occurrencesByNode.get(a.id)?.[0]?.at || graph.timeline.startAt;
        const bAt = occurrencesByNode.get(b.id)?.[0]?.at || graph.timeline.startAt;
        return new Date(aAt) - new Date(bAt) || a.label.localeCompare(b.label);
      });
    const flexible = graph.nodes.filter(node => node.enabled && isFlexible(node));
    return { nodeMap, occurrencesByNode, windowsByNode, scheduled, flexible };
  }, [graph]);

  const selectedNode = selectedId && graph ? graph.nodes.find(node => node.id === selectedId) : null;
  const collisionCount = graph?.timeline?.occurrences.filter(item => item.collision).length || 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-port-accent" />
            <h2 className="text-xl font-semibold text-white">Schedule Timeline</h2>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-gray-400">
            See the real launch order across active task types and system jobs. Select any track to change its timing, frequency, or dependencies without leaving this page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-port-border bg-port-card p-1">
            {[[24, '24 hours'], [168, '7 days']].map(([value, label]) => (
              <button key={value} type="button" onClick={() => setHours(value)} className={`rounded px-2.5 py-1 text-xs ${hours === value ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-gray-300'}`}>{label}</button>
            ))}
          </div>
          <button type="button" onClick={fetchGraph} disabled={loading} className="flex items-center gap-1.5 rounded border border-port-border bg-port-card px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </header>

      {error && <div className="flex items-center gap-2 rounded border border-port-error/40 bg-port-error/10 p-3 text-sm text-port-error"><AlertTriangle className="h-4 w-4" />{error}</div>}
      {loading && !graph && <div className="py-12 text-center text-sm text-gray-500">Building schedule timeline…</div>}

      {graph && model && (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded border border-port-border/60 bg-port-card/30 px-3 py-2">
              <span className="block text-[10px] uppercase tracking-wider text-gray-500">Active schedules</span>
              <span className="mt-0.5 block text-lg font-semibold text-white">{model.scheduled.length}</span>
            </div>
            <div className="rounded border border-port-border/60 bg-port-card/30 px-3 py-2">
              <span className="block text-[10px] uppercase tracking-wider text-gray-500">Launches in view</span>
              <span className="mt-0.5 block text-lg font-semibold text-white">{graph.timeline.occurrences.length}</span>
            </div>
            <div className={`rounded border px-3 py-2 ${collisionCount ? 'border-port-warning/40 bg-port-warning/5' : 'border-port-border/60 bg-port-card/30'}`}>
              <span className="block text-[10px] uppercase tracking-wider text-gray-500">Tight handoffs</span>
              <span className={`mt-0.5 block text-lg font-semibold ${collisionCount ? 'text-port-warning' : 'text-white'}`}>{collisionCount}</span>
              <span className="text-[10px] text-gray-600">launches within 15 min</span>
            </div>
          </div>

          <NextUp occurrences={graph.timeline.occurrences} nodeMap={model.nodeMap} hours={hours} timezone={graph.timezone} onSelect={setSelectedId} />

          <div className={`grid items-start gap-4 ${selectedNode ? '2xl:grid-cols-[minmax(0,1fr)_20rem]' : ''}`}>
            <div className="min-w-0 space-y-3">
              <section className="overflow-hidden rounded-lg border border-port-border/60 bg-port-card/30">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-port-border/60 px-3 py-2 text-[10px] text-gray-500">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-purple-400" /> pinned</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-cyan-400" /> interval job</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rotate-45 rounded-sm bg-amber-300" /> reset/recheck</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400" /> due now (catch-up)</span>
                  </div>
                  <span className="inline-flex items-center gap-1"><CalendarDays className="h-3 w-3" />{graph.timezone}</span>
                </div>
                <div className="overflow-x-auto">
                  <div className="min-w-[56rem]">
                    <div className="grid grid-cols-[14rem_minmax(42rem,1fr)] bg-port-bg/30">
                      <div className="flex items-end border-r border-port-border/50 px-3 pb-1 text-[10px] uppercase tracking-wider text-gray-600">Active tracks</div>
                      <Axis timeline={graph.timeline} hours={hours} timezone={graph.timezone} />
                    </div>
                    {model.scheduled.map(node => (
                      <TimelineRow
                        key={node.id}
                        node={node}
                        occurrences={model.occurrencesByNode.get(node.id) || []}
                        windows={model.windowsByNode.get(node.id) || []}
                        timeline={graph.timeline}
                        hours={hours}
                        timezone={graph.timezone}
                        selected={selectedId === node.id}
                        apps={apps}
                        expanded={expandedIds.has(node.id)}
                        onSelect={setSelectedId}
                        onToggleExpand={toggleExpand}
                        onUpdateOverride={handleUpdateOverride}
                        onBulkToggleOverride={handleBulkToggleOverride}
                      />
                    ))}
                    {model.scheduled.length === 0 && <div className="py-10 text-center text-sm text-gray-500">No active timed schedules in this range.</div>}
                  </div>
                </div>
              </section>

              {model.flexible.length > 0 && (
                <section className="rounded-lg border border-dashed border-port-border/60 bg-port-card/20 p-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-gray-400"><RotateCcw className="h-3.5 w-3.5" /> Unpinned runner queue</div>
                  <p className="mt-1 text-[11px] text-gray-600">These are active, but rotation and on-demand schedules do not promise a clock time.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {model.flexible.map(node => {
                      const canExpand = node.kind === 'task' && (node.totalAppCount || 0) > 0;
                      const isSelected = selectedId === node.id;
                      return (
                        <span key={node.id} className={`inline-flex items-center rounded border text-xs ${isSelected ? 'border-port-accent bg-port-accent/10' : 'border-port-border bg-port-bg/40'}`}>
                          <button type="button" onClick={() => setSelectedId(node.id)} className={`px-2.5 py-1.5 ${isSelected ? 'text-port-accent' : 'text-gray-400 hover:text-white'}`}>
                            {node.label} <span className="text-gray-600">· {node.schedule?.type}</span>
                            {canExpand && <span className={`ml-1 ${node.enabledAppCount > 0 ? 'text-port-accent' : 'text-gray-500'}`}>{node.enabledAppCount || 0}/{node.totalAppCount}</span>}
                          </button>
                          {canExpand && (
                            <button
                              type="button"
                              onClick={() => toggleExpand(node.id)}
                              aria-expanded={expandedIds.has(node.id)}
                              aria-label={`${expandedIds.has(node.id) ? 'Hide' : 'Show'} app overrides for ${node.label}`}
                              title={`${node.enabledAppCount || 0} of ${node.totalAppCount} apps enabled`}
                              className="flex h-full items-center border-l border-port-border/60 px-1.5 text-gray-500 hover:bg-white/10 hover:text-gray-300"
                            >
                              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expandedIds.has(node.id) ? 'rotate-90' : ''}`} />
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                  {model.flexible.filter(node => expandedIds.has(node.id) && node.kind === 'task' && (node.totalAppCount || 0) > 0).map(node => (
                    <div key={node.id} className="mt-2 rounded border border-port-border/60 bg-port-bg/20 px-3 py-3">
                      <div className="mb-2 text-xs font-medium text-gray-300">{node.label} <span className="text-gray-600">· app overrides</span></div>
                      <AppOverridePanel node={node} apps={apps} onUpdateOverride={handleUpdateOverride} onBulkToggleOverride={handleBulkToggleOverride} />
                    </div>
                  ))}
                </section>
              )}

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-gray-600">
                <span><AlertTriangle className="mr-1 inline h-3 w-3 text-port-warning" />A ring means another launch is within 15 minutes; actual overlap depends on runtime.</span>
                <span><Clock3 className="mr-1 inline h-3 w-3 text-amber-300" />An amber marker at Now means the task is already due (catch-up, first run, or overdue) — it launches on the next check rather than waiting for its next cadence slot.</span>
                <span><TimerReset className="mr-1 inline h-3 w-3" />Perpetual bands have no fixed end while backlog remains.</span>
              </div>
            </div>

            {selectedNode && <ScheduleEditor node={selectedNode} allNodes={graph.nodes} timezone={graph.timezone} onClose={() => setSelectedId(null)} onSaved={fetchGraph} />}
          </div>
        </>
      )}
    </div>
  );
}
