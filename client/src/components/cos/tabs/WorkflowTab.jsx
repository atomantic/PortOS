import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, Clock, AlertTriangle, CheckCircle2, Circle, GitBranch, Bot, ArrowRight, Info } from 'lucide-react';
import * as api from '../../../services/api';
import { timeAgo } from '../../../utils/formatters';
import { describeCron } from '../../../utils/cronHelpers';

// Intentional category-color enum (#1909/#1924 caution), left as raw Tailwind
// hues on purpose: 7 mutually-exclusive workflow stages need to stay visually
// distinct in the graph view, and the app's ~4-5 semantic tokens
// (accent/accent-2/success/warning/error) aren't enough to differentiate all 7
// without at least two stages rendering identically.
// Keys are stage ids from the server's WORKFLOW_STAGES; ordering is server-driven (graph.stages).
const STAGE_COLORS = {
  hygiene:  { ring: 'border-cyan-500/40',    bg: 'bg-cyan-500/5',    text: 'text-cyan-300',     dot: 'bg-cyan-500' },
  review:   { ring: 'border-purple-500/40',  bg: 'bg-purple-500/5',  text: 'text-purple-300',   dot: 'bg-purple-500' },
  plan:     { ring: 'border-blue-500/40',    bg: 'bg-blue-500/5',    text: 'text-blue-300',     dot: 'bg-blue-500' },
  audit:    { ring: 'border-amber-500/40',   bg: 'bg-amber-500/5',   text: 'text-amber-300',    dot: 'bg-amber-500' },
  build:    { ring: 'border-emerald-500/40', bg: 'bg-emerald-500/5', text: 'text-emerald-300',  dot: 'bg-emerald-500' },
  report:   { ring: 'border-pink-500/40',    bg: 'bg-pink-500/5',    text: 'text-pink-300',     dot: 'bg-pink-500' },
  ambient:  { ring: 'border-gray-600/40',    bg: 'bg-gray-600/5',    text: 'text-gray-400',     dot: 'bg-gray-500' }
};

function describeSchedule(node) {
  const s = node.schedule || {};
  if (s.type === 'cron' && s.cronExpression) {
    return describeCron(s.cronExpression) || s.cronExpression;
  }
  if (s.type === 'custom' && s.intervalMs) {
    const hours = s.intervalMs / 3_600_000;
    if (hours >= 24) return `every ${Math.round(hours / 24)}d`;
    if (hours >= 1) return `every ${Math.round(hours)}h`;
    return `every ${Math.round(s.intervalMs / 60_000)}m`;
  }
  if (s.type === 'on-demand') return 'on demand';
  return s.type || 'unscheduled';
}

function statusBadge(node) {
  if (!node.enabled) {
    return { label: 'disabled', className: 'bg-gray-700/40 text-gray-500 border-gray-600/40' };
  }
  if (node.blocked) {
    return { label: node.blocked, className: 'bg-port-warning/15 text-port-warning border-port-warning/30' };
  }
  if (node.shouldRun) {
    return { label: 'due', className: 'bg-port-success/15 text-port-success border-port-success/30' };
  }
  return { label: 'waiting', className: 'bg-port-border/30 text-gray-400 border-port-border/50' };
}

function NodeCard({ node, allNodes, onHover, isHighlighted }) {
  const palette = STAGE_COLORS[node.stage] || STAGE_COLORS.ambient;
  const badge = statusBadge(node);
  const Icon = node.kind === 'job' ? Bot : GitBranch;

  // Map runAfter task IDs to nodes for richer hover hints. When the node is blocked on
  // unmet dependencies, mark which prereqs are still outstanding so the user can see at
  // a glance which gate hasn't cleared yet.
  const pendingSet = new Set(Array.isArray(node.pendingDeps) ? node.pendingDeps : []);
  const deps = node.runAfter
    .map(t => {
      const dep = allNodes.find(n => n.id === `task:${t}`);
      return dep ? { ...dep, pending: pendingSet.has(t) } : null;
    })
    .filter(Boolean);
  const isWaitingOnDeps = node.blocked === 'waiting-on-dependencies';

  return (
    <div
      className={`relative rounded-md border ${palette.ring} ${palette.bg} p-2.5 transition-all ${
        isHighlighted ? 'ring-2 ring-port-accent shadow-lg' : ''
      } ${node.enabled ? '' : 'opacity-60'}`}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="flex items-start justify-between gap-1.5 mb-1">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Icon className={`w-3.5 h-3.5 shrink-0 ${palette.text}`} />
          <span className="text-sm text-white font-medium truncate" title={node.label}>{node.label}</span>
        </div>
        {node.enabled
          ? <CheckCircle2 className="w-3.5 h-3.5 text-port-success shrink-0" />
          : <Circle className="w-3.5 h-3.5 text-gray-600 shrink-0" />}
      </div>

      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-1.5">
        <Clock className="w-3 h-3" />
        <span>{describeSchedule(node)}</span>
      </div>

      <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.className}`}>
        {badge.label}
      </span>

      {node.runAfter.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {deps.map(dep => {
            const highlightPending = isWaitingOnDeps && dep.pending;
            return (
              <span
                key={dep.id}
                className={`inline-flex items-center gap-1 text-[10px] ${
                  highlightPending ? 'text-port-warning font-medium' : 'text-gray-500'
                }`}
                title={highlightPending
                  ? `Pending — ${dep.label} hasn't run since this task last ran`
                  : `Runs after ${dep.label}`}
              >
                <ArrowRight className="w-2.5 h-2.5" />
                {dep.label}{highlightPending ? ' ⏳' : ''}
              </span>
            );
          })}
        </div>
      )}

      {(node.lastRun || node.runCount > 0) && (
        <div className="mt-1 text-[10px] text-gray-500">
          last {timeAgo(node.lastRun)} · {node.runCount} run{node.runCount === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function StageColumn({ stage, nodes, allNodes, hoveredId, setHoveredId }) {
  const palette = STAGE_COLORS[stage.id] || STAGE_COLORS.ambient;
  if (nodes.length === 0) return null;

  const hoveredNode = hoveredId ? allNodes.find(n => n.id === hoveredId) : null;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 2xl:flex-1 2xl:basis-0 2xl:min-w-[11rem] 2xl:max-w-[15rem]">
      <div className={`rounded-md border ${palette.ring} ${palette.bg} px-3 py-2`}>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${palette.dot}`} />
          <span className={`text-sm font-semibold ${palette.text}`}>{stage.label}</span>
          <span className="text-xs text-gray-500">
            {stage.enabledCount}/{stage.nodeCount}
          </span>
        </div>
        <p className="text-[11px] text-gray-400 mt-1 leading-snug">{stage.description}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-1 gap-1.5">
        {nodes.map(node => (
          <NodeCard
            key={node.id}
            node={node}
            allNodes={allNodes}
            onHover={setHoveredId}
            isHighlighted={hoveredId === node.id || nodeReferences(node, hoveredId, hoveredNode)}
          />
        ))}
      </div>
    </div>
  );
}

// Highlight nodes that participate in a runAfter relationship with the hovered node — both
// directions. `node` is highlighted when:
//   - `node` declares `hoveredId` as one of its `runAfter` prerequisites (downstream), OR
//   - `node` is itself one of the hovered node's `runAfter` prerequisites (upstream).
// `node` is the candidate being styled; `hoveredNode` is the full node currently under the
// pointer (so we can read its `runAfter` list).
function nodeReferences(node, hoveredId, hoveredNode) {
  if (!hoveredId) return false;
  if (node.runAfter.some(t => `task:${t}` === hoveredId)) return true;
  if (hoveredNode && hoveredNode.runAfter.some(t => `task:${t}` === node.id)) return true;
  return false;
}

function StageArrow() {
  return (
    <div className="hidden 2xl:flex items-center px-2 text-gray-600 shrink-0" aria-hidden="true">
      <ArrowRight className="w-5 h-5" />
    </div>
  );
}

export default function WorkflowTab() {
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    const data = await api.getCosWorkflow().catch(err => {
      setError(err?.message || 'Failed to load workflow');
      return null;
    });
    if (data) {
      setGraph(data);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchGraph(); }, [fetchGraph]);

  // Stages enriched with their nodes, in canonical order from the server, only including those
  // that have content. Keeps node ordering stable: enabled first, then alphabetical.
  const populatedStages = useMemo(() => {
    if (!graph) return [];
    const byStage = new Map();
    for (const node of graph.nodes) {
      if (!byStage.has(node.stage)) byStage.set(node.stage, []);
      byStage.get(node.stage).push(node);
    }
    for (const list of byStage.values()) {
      list.sort((a, b) => (a.enabled === b.enabled ? a.label.localeCompare(b.label) : a.enabled ? -1 : 1));
    }
    // graph.stages is already returned in canonical order; sort defensively by `order` in case
    // a future server change emits them unordered.
    const orderedStages = [...graph.stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return orderedStages
      .map(stage => {
        const nodes = byStage.get(stage.id) || [];
        return nodes.length > 0 ? { ...stage, nodes } : null;
      })
      .filter(Boolean);
  }, [graph]);

  // Total enabled across the whole pipeline
  const totalEnabled = graph ? graph.nodes.filter(n => n.enabled).length : 0;
  const totalNodes = graph ? graph.nodes.length : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-white">Workflow</h2>
          <p className="text-sm text-gray-400 mt-1 max-w-2xl">
            Recommended project-maintenance pipeline. Stages are a visualization of how scheduled
            tasks fit together — each task still runs on its own schedule. Hard execution gates
            are enforced only by per-task <span className="font-mono text-gray-300">runAfter</span> dependencies (and per-job gates),
            not by stage ordering.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {totalEnabled}/{totalNodes} enabled
          </span>
          <button
            onClick={fetchGraph}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent/20 hover:bg-port-accent/30 text-port-accent disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="rounded-md border border-port-border/50 bg-port-card/30 px-3 py-2 flex items-start gap-2 text-xs text-gray-400">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-port-accent" />
        <span>
          Hard dependencies (<span className="font-mono text-gray-300">runAfter</span>) are enforced — a task
          shows <span className="text-port-warning">waiting-on-dependencies</span> until its prerequisites have
          run since its last execution. Stage ordering left-to-right is the recommended workflow; you can still
          schedule tasks independently from the Schedule and System Tasks tabs.
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-port-error/40 bg-port-error/10 p-3 flex items-center gap-2 text-sm text-port-error">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}

      {loading && !graph && (
        <div className="text-center py-8 text-gray-500">Loading workflow…</div>
      )}

      {graph && (
        <div className="2xl:overflow-x-auto pb-2">
          <div className="flex flex-col 2xl:flex-row 2xl:items-stretch gap-4 2xl:gap-0 2xl:min-w-min">
            {populatedStages.map((stage, i) => (
              <Fragment key={stage.id}>
                <StageColumn
                  stage={stage}
                  nodes={stage.nodes}
                  allNodes={graph.nodes}
                  hoveredId={hoveredId}
                  setHoveredId={setHoveredId}
                />
                {i < populatedStages.length - 1 && <StageArrow />}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      {graph && (
        <div className="text-xs text-gray-500">
          Generated {timeAgo(graph.generatedAt)}
        </div>
      )}
    </div>
  );
}
