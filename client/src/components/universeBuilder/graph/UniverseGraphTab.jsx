/**
 * Universe Builder → Graph tab.
 *
 * Reads the server-derived relationship graph once per universe and drives the
 * canvas, inspector, timeline and poster builder off one in-memory index. The
 * selected node lives in the URL (`?node=`) so a specific character's
 * neighbourhood is shareable and survives a reload.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Loader2, Network } from 'lucide-react';
import { getUniverseGraph } from '../../../services/api';
import {
  GRAPH_EDGE_GROUPS, GRAPH_KIND_ORDER, computeUniverseGaps, edgeDef, indexGraph, neighbourIds,
} from '../../../lib/universeGraphModel';
import GraphCanvas from './GraphCanvas';
import GraphInspector from './GraphInspector';
import GraphTimeline from './GraphTimeline';
import GraphToolbar from './GraphToolbar';
import PosterBuilderModal from './PosterBuilderModal';

const EMPTY_GRAPH = { nodes: [], edges: [], issues: [], series: [], totalIssues: 0, appear: {}, name: '' };

export default function UniverseGraphTab({ universeId, universeName }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [kinds, setKinds] = useState(() => new Set(GRAPH_KIND_ORDER));
  const [groups, setGroups] = useState(() => new Set(GRAPH_EDGE_GROUPS.map((g) => g.id)));
  const [layout, setLayout] = useState('force');
  const [search, setSearch] = useState('');
  const [hoveredId, setHoveredId] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const [timeIndex, setTimeIndex] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [gapsOpen, setGapsOpen] = useState(false);
  const [gapCategory, setGapCategory] = useState('all');
  const [poster, setPoster] = useState(null);
  const [resetToken, setResetToken] = useState(0);

  const selectedId = searchParams.get('node');

  useEffect(() => {
    if (!universeId) { setGraph(null); setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // The tab already renders its own empty/error state, so the shared toast
    // would be a second report of the same failure.
    getUniverseGraph(universeId, { silent: true })
      .then((data) => { if (!cancelled) { setGraph(data); setLoading(false); } })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Could not load the universe graph.');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [universeId]);

  const index = useMemo(() => indexGraph(graph || { ...EMPTY_GRAPH, name: universeName }), [graph, universeName]);
  const gaps = useMemo(() => computeUniverseGaps(index), [index]);
  const gapCounts = useMemo(() => {
    const counts = { all: gaps.length };
    for (const gap of gaps) counts[gap.cat] = (counts[gap.cat] || 0) + 1;
    return counts;
  }, [gaps]);

  const kindCounts = useMemo(() => {
    const counts = Object.fromEntries(GRAPH_KIND_ORDER.map((k) => [k, 0]));
    for (const node of index.nodes) counts[node.kind] = (counts[node.kind] || 0) + 1;
    return counts;
  }, [index]);

  // The visible subset: kind filter → focus neighbourhood → edge-group filter,
  // plus the search match set the canvas dims non-matches against.
  const visible = useMemo(() => {
    let nodes = index.nodes.filter((n) => kinds.has(n.kind));
    if (focusId && index.byId.has(focusId)) {
      const near = neighbourIds(index, focusId);
      nodes = nodes.filter((n) => near.has(n.id));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = index.edges.filter((e) =>
      ids.has(e.source) && ids.has(e.target) && groups.has(edgeDef(e.type).group));
    const query = search.trim().toLowerCase();
    const match = query
      ? new Set(nodes
        .filter((n) => n.name.toLowerCase().includes(query) || (n.role || '').toLowerCase().includes(query))
        .map((n) => n.id))
      : null;
    const degree = new Map(nodes.map((n) => [n.id, 0]));
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
    return { nodes, edges, match, degree };
  }, [index, kinds, groups, focusId, search]);

  const selectNode = useCallback((nodeId) => {
    const next = new URLSearchParams(searchParams);
    if (nodeId) next.set('node', nodeId);
    else next.delete('node');
    setSearchParams(next, { replace: true });
    if (nodeId) setGapsOpen(false);
  }, [searchParams, setSearchParams]);

  // A `?node=` pointing at a record that no longer exists would leave the
  // inspector permanently blank, so drop it once the graph has loaded.
  useEffect(() => {
    if (loading || !selectedId || index.byId.has(selectedId)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('node');
    setSearchParams(next, { replace: true });
  }, [loading, selectedId, index, searchParams, setSearchParams]);

  const toggleKind = useCallback((kind) => setKinds((prev) => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    return next;
  }), []);
  const toggleGroup = useCallback((group) => setGroups((prev) => {
    const next = new Set(prev);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  }), []);

  const stats = useMemo(() => [
    { label: 'Characters', value: kindCounts.character || 0 },
    { label: 'Places · Objects', value: `${kindCounts.place || 0} · ${kindCounts.object || 0}` },
    { label: 'Typed relationships', value: index.edges.filter((e) => e.directed).length },
    { label: 'Series · Issues', value: `${kindCounts.series || 0} · ${kindCounts.issue || 0}` },
    { label: 'Images & sheets', value: (kindCounts.image || 0) + (kindCounts.composite || 0) },
  ], [kindCounts, index]);

  const topNodes = useMemo(() => index.nodes
    .filter((n) => n.kind !== 'issue' && n.kind !== 'image')
    .sort((a, b) => (index.degree.get(b.id) || 0) - (index.degree.get(a.id) || 0))
    .slice(0, 8), [index]);

  const entriesIntroduced = useMemo(() => (timeIndex == null ? 0 : index.nodes.filter(
    (n) => (n.firstIssue || 0) <= timeIndex && n.kind !== 'issue' && n.kind !== 'image',
  ).length), [index, timeIndex]);

  const statsLabel = `${visible.nodes.length} nodes · ${visible.edges.length} links${
    search ? ` · ${visible.match ? visible.match.size : 0} matches` : ''}`;

  if (!universeId) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-sm text-gray-400">
        Save this universe to see its relationship graph.
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-sm text-port-error">
        {error}
      </div>
    );
  }

  if (loading && !graph) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-sm text-gray-400 flex items-center gap-2">
        <Loader2 size={16} className="animate-spin" /> Building graph…
      </div>
    );
  }

  if (index.nodes.length === 0) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-sm text-gray-400 flex items-start gap-3">
        <Network size={18} className="text-gray-500 shrink-0 mt-0.5" />
        <span>
          Nothing to graph yet. Add canon entries on the Cast, Places, or Objects tabs — the graph
          draws the relationships, attachments and series appearances they carry.
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <GraphToolbar
        search={search}
        onSearchChange={setSearch}
        layout={layout}
        onLayoutChange={setLayout}
        kinds={kinds}
        onToggleKind={toggleKind}
        groups={groups}
        onToggleGroup={toggleGroup}
        kindCounts={kindCounts}
        gapCount={gaps.length}
        gapsOpen={gapsOpen}
        onToggleGaps={() => setGapsOpen((open) => !open)}
        onOpenPoster={() => setPoster({ layout: 'roster', subjectId: null })}
        onResetView={() => { setFocusId(null); setResetToken((n) => n + 1); }}
      />

      <div className="flex-1 flex flex-col lg:flex-row gap-3 min-h-[520px]">
        <GraphCanvas
          index={index}
          visible={visible}
          layout={layout}
          kinds={kinds}
          selectedId={selectedId}
          hoveredId={hoveredId}
          focusId={focusId}
          timeIndex={timeIndex}
          loading={loading}
          statsLabel={statsLabel}
          resetToken={resetToken}
          onSelect={selectNode}
          onHover={setHoveredId}
          onFocus={setFocusId}
        />
        <GraphInspector
          index={index}
          selectedNode={selectedId ? index.byId.get(selectedId) : null}
          timeIndex={timeIndex}
          gaps={gaps}
          gapCounts={gapCounts}
          gapsOpen={gapsOpen}
          gapCategory={gapCategory}
          stats={stats}
          topNodes={topNodes}
          onPick={selectNode}
          onClear={() => selectNode(null)}
          onFocus={setFocusId}
          onDossierPoster={(nodeId) => setPoster({ layout: 'dossier', subjectId: nodeId })}
          onGapCategoryChange={setGapCategory}
          onCloseGaps={() => setGapsOpen(false)}
        />
      </div>

      <GraphTimeline
        index={index}
        timeIndex={timeIndex}
        onTimeChange={setTimeIndex}
        playing={playing}
        onPlayingChange={setPlaying}
        entriesIntroduced={entriesIntroduced}
      />

      <PosterBuilderModal
        index={index}
        open={!!poster}
        initialLayout={poster?.layout}
        initialSubjectId={poster?.subjectId}
        timeIndex={timeIndex}
        onClose={() => setPoster(null)}
      />
    </div>
  );
}
