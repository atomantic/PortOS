import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {AlertTriangle, Zap, RefreshCw, X, ChevronRight, ArrowLeft, Compass, Info} from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import { BRAIN_TYPE_HEX, DESTINATIONS } from '../constants';
import { buildGraph } from '../../../lib/graphSimulation';
import { pushFocus, popFocus, currentFocusId } from '../../../lib/brainGraphFocus';
import EntityCombobox from '../../EntityCombobox';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import BrailleSpinner from '../../BrailleSpinner';

const EDGE_COLORS = {
  similar: '#3b82f6',
  shared_tag: '#f59e0b',
  linked: '#ffffff'
};

const BRAIN_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories', 'goals', 'journals'];

// Widest the hover tooltip renders. Single source for both its max-width and
// the clamp that keeps it inside the viewport — as a CSS class plus a mirrored
// constant the two silently drift apart.
const TOOLTIP_WIDTH = 320;

// Per-type API getters for detail panel
const TYPE_GETTERS = {
  people: api.getBrainPerson,
  projects: api.getBrainProject,
  ideas: api.getBrainIdea,
  admin: api.getBrainAdminItem,
  memories: api.getBrainMemory,
  goals: api.getBrainGoal,
  journals: api.getBrainJournalEntry
};

function GraphEdges({ simEdges, selectedId }) {
  const geoRef = useRef();

  useEffect(() => {
    const geo = geoRef.current;
    if (!geo || !simEdges.length) return;

    const count = simEdges.length;
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const tmpColor = new THREE.Color();

    simEdges.forEach((e, i) => {
      const a = e.sourceNode, b = e.targetNode;
      const off = i * 6;
      positions[off] = a.x; positions[off + 1] = a.y; positions[off + 2] = a.z;
      positions[off + 3] = b.x; positions[off + 4] = b.y; positions[off + 5] = b.z;

      const dimmed = selectedId && e.source !== selectedId && e.target !== selectedId;
      tmpColor.set(EDGE_COLORS[e.type] || '#6b7280');
      const intensity = dimmed ? 0.06 : (e.type === 'linked' ? 0.6 : 0.3 * (e.weight || 0.5));
      const r = tmpColor.r * intensity, g = tmpColor.g * intensity, bl = tmpColor.b * intensity;
      colors[off] = r; colors[off + 1] = g; colors[off + 2] = bl;
      colors[off + 3] = r; colors[off + 4] = g; colors[off + 5] = bl;
    });

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
  }, [simEdges, selectedId]);

  return (
    <lineSegments>
      <bufferGeometry ref={geoRef} />
      <lineBasicMaterial vertexColors />
    </lineSegments>
  );
}

// Memoized: the container's onPointerMove re-renders BrainGraph on every mouse
// move over the canvas (it tracks the tooltip position), and every prop here is
// already identity-stable across that render — so without memo each move
// reconciles a <mesh> per node for nothing.
const GraphScene = memo(function GraphScene({ graph, selectedId, adjacentIds, onSelect, onFocus, onHover }) {
  const sphereGeo = useMemo(() => new THREE.SphereGeometry(1, 16, 12), []);

  const selNode = selectedId ? graph.idMap.get(selectedId) : null;
  const selRadius = selNode ? 0.4 + (selNode.importance ?? 0.5) * 0.8 : 0;

  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[50, 50, 50]} intensity={0.8} />
      <pointLight position={[-30, -30, -30]} intensity={0.3} />

      <GraphEdges simEdges={graph.simEdges} selectedId={selectedId} />

      {graph.simNodes.map(node => {
        const radius = 0.4 + (node.importance ?? 0.5) * 0.8;
        const color = BRAIN_TYPE_HEX[node.brainType] || '#6b7280';
        const isSelected = node.id === selectedId;
        const isConnected = adjacentIds?.has(node.id);
        const dimmed = selectedId && !isSelected && !isConnected;

        return (
          <mesh
            key={node.id}
            geometry={sphereGeo}
            scale={radius}
            position={[node.x, node.y, node.z]}
            onClick={(e) => { e.stopPropagation(); onSelect(node); }}
            onDoubleClick={(e) => { e.stopPropagation(); onFocus(node); }}
            onPointerOver={(e) => { e.stopPropagation(); onHover(node); }}
            onPointerOut={() => onHover(null)}
          >
            <meshStandardMaterial
              color={dimmed ? '#1a1a1a' : color}
              emissive={color}
              emissiveIntensity={isSelected ? 0.6 : (dimmed ? 0.03 : 0.2)}
            />
          </mesh>
        );
      })}

      {selNode && (
        <mesh geometry={sphereGeo} position={[selNode.x, selNode.y, selNode.z]} scale={selRadius + 0.2}>
          <meshBasicMaterial color="#ffffff" transparent opacity={0.15} wireframe />
        </mesh>
      )}

      <OrbitControls enableDamping dampingFactor={0.05} minDistance={10} maxDistance={200} />
    </>
  );
});

export default function BrainGraph() {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [subLoading, setSubLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [fullRecord, setFullRecord] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [layoutKey, setLayoutKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [confirmingRefresh, setConfirmingRefresh] = useState(false);
  const [searchIndex, setSearchIndex] = useState([]);
  const [searchValue, setSearchValue] = useState('');
  const [focusTrail, setFocusTrail] = useState([]);
  const [embeddingStatus, setEmbeddingStatus] = useState(null);
  // Mobile-only: the legend is always shown from `sm` up (CSS, not this flag).
  const [legendOpen, setLegendOpen] = useState(false);
  const [typeFilters, setTypeFilters] = useState(() =>
    Object.fromEntries(BRAIN_TYPES.map(t => [t, true]))
  );

  const graphRef = useRef(null);
  const dragStartRef = useRef(null);

  const focusId = currentFocusId(focusTrail);

  // Initial load: bounded overview + lightweight search index + embedding gaps.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getBrainGraph().catch(() => null),
      api.getBrainGraphSearchIndex().catch(() => ({ nodes: [] })),
      api.getEmbeddingsStatus().catch(() => null)
    ]).then(([graph, index, status]) => {
      if (cancelled) return;
      setGraphData(graph);
      setSearchIndex(index?.nodes || []);
      setEmbeddingStatus(status);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Load a bounded view (overview when focusId is null, else that node's
  // neighborhood) and reconcile the breadcrumb trail.
  const loadView = useCallback(async (targetFocusId, { trail } = {}) => {
    setSubLoading(true);
    const data = await api.getBrainGraph(targetFocusId ? { focus: targetFocusId } : {}, { silent: true }).catch(() => null);
    setSubLoading(false);
    if (!data || data.notFound) {
      toast.error('Could not load those connections');
      return false;
    }
    setGraphData(data);
    if (trail !== undefined) setFocusTrail(trail);
    setSelectedNode(targetFocusId ? (data.nodes.find(n => n.id === targetFocusId) || null) : null);
    return true;
  }, []);

  const focusNode = useCallback(async (node) => {
    if (!node?.id || node.id === focusId) return;
    const nextTrail = pushFocus(focusTrail, { id: node.id, label: node.label || node.id });
    await loadView(node.id, { trail: nextTrail });
  }, [focusId, focusTrail, loadView]);

  const goBack = useCallback(async () => {
    const { trail, focusId: prevFocus } = popFocus(focusTrail);
    await loadView(prevFocus, { trail });
  }, [focusTrail, loadView]);

  const goToOverview = useCallback(async () => {
    await loadView(null, { trail: [] });
  }, [loadView]);

  // The search index covers every brain record (unbounded, unlike the loaded
  // view), so keep a stable mapping — rebuilt inline it re-allocated the whole
  // list on every tooltip-position render and re-ran the combobox's filters.
  const searchItems = useMemo(() => searchIndex.map(n => ({
    id: n.id,
    name: n.label,
    subtitle: DESTINATIONS[n.brainType]?.label || n.brainType
  })), [searchIndex]);

  // Filter the (already bounded) loaded nodes by type toggles.
  const filteredData = useMemo(() => {
    if (!graphData?.nodes?.length) return null;
    const filteredNodes = graphData.nodes.filter(n => typeFilters[n.brainType]);
    const nodeIds = new Set(filteredNodes.map(n => n.id));
    const filteredEdges = graphData.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
    return { nodes: filteredNodes, edges: filteredEdges };
  }, [graphData, typeFilters]);

  const graph = useMemo(() => {
    if (!filteredData?.nodes?.length) return null;
    const g = buildGraph(filteredData.nodes, filteredData.edges);
    graphRef.current = g;
    return g;
  }, [filteredData, layoutKey]);

  const adjacentIds = useMemo(() => {
    if (!selectedNode || !graph) return null;
    const set = new Set();
    for (const e of graph.simEdges) {
      if (e.source === selectedNode.id) set.add(e.target);
      if (e.target === selectedNode.id) set.add(e.source);
    }
    return set;
  }, [selectedNode, graph]);

  const connectedEdges = selectedNode && graph
    ? graph.simEdges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id)
    : [];
  const connectedNodes = selectedNode && graph
    ? connectedEdges.map(e => {
        const otherId = e.source === selectedNode.id ? e.target : e.source;
        const n = graph.idMap.get(otherId);
        return n ? { ...n, edgeType: e.type, weight: e.weight } : null;
      }).filter(Boolean)
    : [];

  // Fetch full brain record when a node is selected
  useEffect(() => {
    if (!selectedNode) { setFullRecord(null); return; }
    let cancelled = false;
    const getter = TYPE_GETTERS[selectedNode.brainType];
    if (!getter) return;
    getter(selectedNode.id).then(record => {
      if (!cancelled) setFullRecord(record);
    }).catch(() => {
      if (!cancelled) setFullRecord(null);
    });
    return () => { cancelled = true; };
  }, [selectedNode]);

  const handleSelect = useCallback((node) => {
    setSelectedNode(prev => prev?.id === node.id ? null : node);
  }, []);

  const handleHover = useCallback((node) => {
    setHoveredNode(node);
  }, []);

  // Escape always clears selection. Clicking "empty space" is unreliable for
  // un-isolating: unselected nodes are only dimmed (not removed), so they still
  // capture clicks, and onPointerMissed ignores any orbit drag — leaving the
  // user stuck on an isolated node with no obvious way out.
  useEffect(() => {
    if (!selectedNode) return;
    const onKey = (e) => { if (e.key === 'Escape') setSelectedNode(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNode]);

  const handlePointerMissed = useCallback((e) => {
    const start = dragStartRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) < 5 && Math.abs(e.clientY - start.y) < 5) {
      setSelectedNode(null);
    }
  }, []);

  // refresh:true re-embeds already-mapped records — the recovery path for
  // memory entries that diverged before synced-in records were re-vectorized
  // automatically (issue #1080). onlyMissing:true embeds just the records that
  // lack an embedding (cheap; no confirm). Default sync only embeds new records.
  const handleSync = async ({ refresh = false, onlyMissing = false } = {}) => {
    setSyncing(true);
    setConfirmingRefresh(false);
    // The server has no progress stream for this, so a persistent loading toast
    // is the only honest signal that work is in flight. A fixed id lets the
    // success/error call swap the same toast in place.
    const toastId = 'brain-embeddings-sync';
    toast.loading(
      refresh
        ? 'Refreshing embeddings — re-embedding all brain records. This can take a while…'
        : onlyMissing
          ? 'Embedding records that are missing embeddings…'
          : 'Syncing brain data to memory…',
      { id: toastId }
    );
    // silent:true — this catch owns the error toast (CLAUDE.md: custom catch ⇒ silent).
    const stats = await api.syncBrainData({ refresh, onlyMissing }, { silent: true }).catch(err => {
      toast.error(err.message || 'Sync failed', { id: toastId });
      return null;
    });
    setSyncing(false);
    if (stats) {
      const archivedNote = stats.archived ? `, ${stats.archived} archived` : '';
      toast.success(`Synced ${stats.synced} records (${stats.skipped} skipped${archivedNote})`, { id: toastId });
      // Refresh the missing-embeddings count and reload the current view to pick
      // up the new edges.
      api.getEmbeddingsStatus().then(setEmbeddingStatus).catch(() => {});
      const fresh = await api.getBrainGraph(focusId ? { focus: focusId } : {}).catch(() => null);
      if (fresh) setGraphData(fresh);
    }
  };

  const toggleType = (type) => {
    setTypeFilters(prev => ({ ...prev, [type]: !prev[type] }));
    setSelectedNode(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  if (!graphData?.nodes?.length) {
    return (
      <div className="text-center py-12 text-gray-500">
        No brain entities to graph. Add people, projects, ideas, admin items, memories, goals, or journal entries to see relationships.
      </div>
    );
  }

  const missingCount = embeddingStatus?.missing || 0;

  return (
    // Full-bleed tab: own the scroll (the Brain wrapper is overflow-hidden) and
    // restore the edge padding the shared wrapper no longer provides (#1177).
    <div className="h-full overflow-y-auto p-3 sm:p-4 space-y-3">
      {/* No-embeddings banner */}
      {graphData && !graphData.hasEmbeddings && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-port-warning/10 border border-port-warning/30 rounded-lg px-3 sm:px-4 py-2.5">
          <div className="flex items-start gap-2 text-sm text-port-warning">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>No embeddings found. Sync brain data to CoS memory to enable semantic similarity edges.</span>
          </div>
          <button
            onClick={() => handleSync({ onlyMissing: true })}
            disabled={syncing}
            className="flex items-center justify-center gap-1.5 self-start sm:self-auto shrink-0 px-3 py-1.5 min-h-[36px] text-xs font-medium bg-port-warning/20 text-port-warning border border-port-warning/30 rounded-lg hover:bg-port-warning/30 transition-colors disabled:opacity-50"
          >
            {syncing ? <BrailleSpinner /> : <Zap size={14} />}
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      )}

      {/* Search — jump to any memory across the whole brain (not just the
          loaded view) and focus its neighborhood. */}
      <div className="flex items-center gap-2">
        <EntityCombobox
          items={searchItems}
          value={searchValue}
          onChange={setSearchValue}
          onPick={(item) => { focusNode({ id: item.id, label: item.name }); setSearchValue(''); }}
          inputId="brain-graph-search"
          noun="memory"
          placeholder="Search memories to explore…"
          // min-w-0 (not the default 200px floor) so the field still shrinks
          // beside the "N missing" button on a ~320px screen instead of
          // overflowing the row.
          className="flex-1 min-w-0"
        />
        {missingCount > 0 && (
          <button
            onClick={() => handleSync({ onlyMissing: true })}
            disabled={syncing}
            title={`${missingCount} of ${embeddingStatus?.total ?? '?'} records have no embedding yet — embed just those (fast)`}
            className="flex items-center gap-1.5 shrink-0 px-3 py-2 min-h-[36px] text-xs whitespace-nowrap bg-port-warning/15 text-port-warning border border-port-warning/30 rounded-lg hover:bg-port-warning/25 transition-colors disabled:opacity-50"
          >
            {syncing ? <BrailleSpinner /> : <Zap size={14} />}
            {missingCount} missing · Embed
          </button>
        )}
      </div>

      {/* Breadcrumb trail + controls bar. Below `sm` this stacks into three
          rows (trail / filters / stats+actions) — as one flex row the seven
          type filters shoved the breadcrumb and buttons into a jumble. */}
      <div className="bg-port-card border border-port-border rounded-lg px-3 sm:px-4 py-2 space-y-2 sm:space-y-0 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
        {/* Breadcrumb — scrolls sideways rather than wrapping a deep trail */}
        <div className="flex items-center gap-1 text-xs min-w-0 overflow-x-auto">
          {focusTrail.length > 0 && (
            <button
              onClick={goBack}
              title="Back"
              aria-label="Back"
              className="flex items-center gap-1 shrink-0 px-2 py-1 text-gray-400 hover:text-white rounded transition-colors"
            >
              <ArrowLeft size={13} />
            </button>
          )}
          <button
            onClick={goToOverview}
            disabled={focusTrail.length === 0}
            className={`shrink-0 px-1.5 py-1 rounded transition-colors ${focusTrail.length === 0 ? 'text-white font-medium' : 'text-gray-400 hover:text-white'}`}
          >
            Overview
          </button>
          {focusTrail.map((entry, i) => (
            // shrink-0 so a deep trail scrolls the row instead of flex-shrinking
            // every label into an unreadable sliver on a narrow screen.
            <span key={entry.id} className="flex items-center gap-1 shrink-0">
              <ChevronRight size={12} className="text-gray-600 shrink-0" />
              <span className={`px-1 truncate max-w-[140px] ${i === focusTrail.length - 1 ? 'text-white font-medium' : 'text-gray-500'}`}>
                {entry.label}
              </span>
            </span>
          ))}
        </div>

        {/* Type filter checkboxes — wrap on mobile (seven of them never fit a
            phone row) with a taller tap target than the 12px swatch alone. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:ml-auto">
          {BRAIN_TYPES.map(type => {
            const dest = DESTINATIONS[type];
            return (
              <label key={type} className="flex items-center gap-1.5 cursor-pointer select-none text-sm py-1.5 sm:py-0 min-h-[32px] sm:min-h-0">
                <input
                  type="checkbox"
                  checked={typeFilters[type]}
                  onChange={() => toggleType(type)}
                  className="sr-only"
                />
                <span
                  className={`inline-block w-3 h-3 rounded-sm border-2 transition-colors ${
                    typeFilters[type] ? 'border-transparent' : 'border-gray-600 bg-transparent'
                  }`}
                  style={typeFilters[type] ? { backgroundColor: BRAIN_TYPE_HEX[type] } : undefined}
                />
                <span className={typeFilters[type] ? 'text-gray-300' : 'text-gray-600'}>{dest?.label || type}</span>
              </label>
            );
          })}
        </div>

        {/* Stats + actions — kept together so they share a row on mobile
            instead of each wrapping onto a line of their own. */}
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="text-xs sm:text-sm text-gray-400 mr-auto sm:mr-0">
            {filteredData?.nodes?.length || 0} nodes &middot; {filteredData?.edges?.length || 0} edges
          </span>
          <button
            onClick={() => { setSelectedNode(null); setLayoutKey(k => k + 1); }}
            className="px-3 py-1.5 min-h-[36px] text-xs bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors"
          >
            Re-layout
          </button>
          {/* Recovery action (issue #1080): re-embed already-synced records whose
              memory copy may be stale. Confirmed first — it re-embeds every record
              and can run for many minutes. The cheaper "Embed missing" above is the
              usual path; this is the heavy reset. */}
          <button
            onClick={() => setConfirmingRefresh(true)}
            disabled={syncing || confirmingRefresh}
            title="Re-embed ALL brain records, including ones synced from peers. Slow — use 'Embed missing' for the common case."
            className="flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {syncing ? <BrailleSpinner /> : <RefreshCw size={14} />}
            Refresh all
          </button>
        </div>
      </div>

      {confirmingRefresh && (
        <InlineConfirmRow
          tone="warning"
          question={`Re-embed all ${embeddingStatus?.total ?? ''} brain records? This can take several minutes.`}
          confirmText="Refresh all"
          cancelText="Cancel"
          onConfirm={() => handleSync({ refresh: true })}
          onCancel={() => setConfirmingRefresh(false)}
        />
      )}

      {/* 3D Canvas. Viewport-relative rather than a flat 500px: the canvas is a
          touch-action:none dead zone for page scrolling, so on a phone (and
          especially in landscape, where 500px overflowed the whole viewport) it
          has to leave room to scroll past. Caps at the original 500px on
          desktop, floors at 240px so it stays usable on a short viewport. */}
      <div
        className="relative bg-port-card border border-port-border rounded-lg overflow-hidden h-[clamp(240px,45vh,500px)]"
        onPointerDown={(e) => { dragStartRef.current = { x: e.clientX, y: e.clientY }; }}
        onPointerMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
      >
        {graph && (
          <Canvas
            camera={{ position: [0, 0, 80], fov: 50 }}
            dpr={[1, 1.5]}
            style={{ background: 'rgb(var(--port-bg))' }}
            gl={{ antialias: true }}
            onPointerMissed={handlePointerMissed}
          >
            <GraphScene
              graph={graph}
              selectedId={selectedNode?.id}
              adjacentIds={adjacentIds}
              onSelect={handleSelect}
              onFocus={focusNode}
              onHover={handleHover}
            />
          </Canvas>
        )}

        {!graph && (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            No nodes match the current filters.
          </div>
        )}

        {/* Loading overlay while switching focus */}
        {subLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-port-bg/60 z-20">
            <BrailleSpinner text="Loading connections" />
          </div>
        )}

        {/* Always-reachable un-isolate control. Dimmed nodes still capture
            clicks, so clicking "empty space" can't be relied on to clear the
            selection — give the user an unmissable exit (also bound to Esc). */}
        {selectedNode && (
          <button
            onClick={() => setSelectedNode(null)}
            title="Clear selection (Esc)"
            className="absolute top-3 right-3 z-10 flex items-center gap-1.5 px-3 py-1.5 text-xs bg-port-bg/90 border border-port-border text-gray-300 hover:text-white rounded-lg transition-colors"
          >
            <X size={14} />
            Clear selection
          </button>
        )}

        {/* Legend. Its ~200px blankets a short canvas, so it auto-shows only on
            a `roomy-viewport` (wide AND tall — see index.css); otherwise it
            collapses behind a toggle and expands upward from the corner. The
            height half of that variant is what makes a landscape phone work: it
            is wider than `sm` but only ~390px tall, so a width-only rule
            force-showed the legend over a floored 240px canvas AND hid the
            toggle — blanketing the graph with no way out.
            (The type filters above already duplicate the colour→label mapping,
            but the edge colours are only here — hence a toggle, not a drop.) */}
        {/* pointer-events-none on the WRAPPER, not just the panel: it covers a
            corner of the canvas, and as a hit-testable box it would swallow the
            orbit drags the panel alone used to let through (pointer-events is
            inherited, so the panel needs no declaration of its own; the toggle
            opts back in). */}
        <div className="absolute bottom-3 left-3 z-10 flex flex-col items-start gap-1.5 pointer-events-none">
          <div
            data-testid="graph-legend"
            className={`${legendOpen ? 'block' : 'hidden'} roomy-viewport:block bg-port-bg/90 border border-port-border rounded-lg p-3 text-xs space-y-1.5`}
          >
            {BRAIN_TYPES.map(t => (
              <div key={t} className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: BRAIN_TYPE_HEX[t] }} />
                <span className="text-gray-400">{DESTINATIONS[t]?.label || t}</span>
              </div>
            ))}
            <div className="border-t border-port-border pt-1.5 mt-1.5 space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-block w-4 h-0 border-t" style={{ borderColor: EDGE_COLORS.similar }} />
                <span className="text-gray-500">similar</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-4 h-0 border-t" style={{ borderColor: EDGE_COLORS.shared_tag }} />
                <span className="text-gray-500">shared tag</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-4 h-0 border-t" style={{ borderColor: EDGE_COLORS.linked }} />
                <span className="text-gray-500">linked</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => setLegendOpen(o => !o)}
            aria-expanded={legendOpen}
            className="roomy-viewport:hidden pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 min-h-[32px] text-[11px] bg-port-bg/90 border border-port-border text-gray-400 hover:text-white rounded-lg transition-colors"
          >
            <Info size={12} />
            Legend
          </button>
        </div>

        {/* Hover tooltip. Suppressed on a coarse pointer: there is no hover to
            preview with — a tap selects the node and the detail panel below
            already shows the same record — and it would otherwise flash under
            the user's own finger advertising a double-click touch can't do.
            Position is clamped so it can't run off the right edge of a narrow
            window, where `x + 12` alone would clip the label. */}
        {hoveredNode && (
          <div
            className="fixed z-50 pointer-events-none pointer-coarse:hidden bg-port-bg border border-port-border rounded-lg px-3 py-2 shadow-lg"
            style={{
              maxWidth: TOOLTIP_WIDTH,
              left: Math.max(8, Math.min(tooltipPos.x + 12, window.innerWidth - TOOLTIP_WIDTH - 8)),
              top: Math.max(8, tooltipPos.y - 12)
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className="px-1.5 py-0.5 text-[10px] rounded-full border"
                style={{ borderColor: BRAIN_TYPE_HEX[hoveredNode.brainType], color: BRAIN_TYPE_HEX[hoveredNode.brainType] }}
              >
                {DESTINATIONS[hoveredNode.brainType]?.label || hoveredNode.brainType}
              </span>
            </div>
            <p className="text-xs text-white leading-snug font-medium">{hoveredNode.label}</p>
            {hoveredNode.summary && (
              <p className="text-[10px] text-gray-400 mt-0.5 line-clamp-2">{hoveredNode.summary}</p>
            )}
            <p className="text-[10px] text-gray-600 mt-1">Double-click to explore connections</p>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedNode && (
        <div className="bg-port-card border border-port-border rounded-lg p-3 sm:p-4">
          {/* Identity + dismiss. The record body is deliberately NOT nested in
              this row — see the action row below. */}
          <div className="flex items-start justify-between gap-2 sm:gap-3 mb-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="px-2 py-1 text-xs rounded-full border"
                  style={{ borderColor: BRAIN_TYPE_HEX[selectedNode.brainType], color: BRAIN_TYPE_HEX[selectedNode.brainType] }}
                >
                  {DESTINATIONS[selectedNode.brainType]?.label || selectedNode.brainType}
                </span>
                {selectedNode.status && (
                  <span className="text-xs text-gray-500">{selectedNode.status}</span>
                )}
              </div>
              <h3 className="text-sm font-medium text-white mb-1">{selectedNode.label}</h3>
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              title="Clear selection (Esc)"
              aria-label="Clear selection"
              className="shrink-0 text-gray-500 hover:text-white transition-colors p-1"
            >
              &times;
            </button>
          </div>

          {/* "Explore connections" — the touch stand-in for double-clicking a
              node, so it has to stay reachable. Its own row rather than a fixed
              ~160px column beside the body (which squeezed the text to a sliver
              on a phone), but ABOVE the body rather than after it: a memory's
              or journal's `notes`/`content` is unbounded and unclamped, so
              trailing the body could push this several screens down. */}
          {selectedNode.id !== focusId && (
            <button
              onClick={() => focusNode(selectedNode)}
              className="flex items-center justify-center sm:justify-start gap-1.5 w-full sm:w-auto mb-3 px-2.5 py-2 sm:py-1.5 min-h-[36px] text-xs bg-port-accent/20 text-port-accent border border-port-accent/30 rounded-lg hover:bg-port-accent/30 transition-colors whitespace-nowrap"
            >
              <Compass size={13} />
              Explore connections
            </button>
          )}

          <div className="mb-3">
            {fullRecord ? (
              <div className="space-y-3">
                {(fullRecord.description || fullRecord.context || fullRecord.oneLiner || fullRecord.notes || fullRecord.content) && (
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">
                    {fullRecord.description || fullRecord.context || fullRecord.oneLiner || fullRecord.notes || fullRecord.content}
                  </p>
                )}
                {typeof fullRecord.progress === 'number' && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-port-border rounded-full overflow-hidden">
                      <div className="h-full bg-port-accent rounded-full" style={{ width: `${Math.min(100, Math.max(0, fullRecord.progress))}%` }} />
                    </div>
                    <span className="text-xs text-gray-500">{fullRecord.progress}%</span>
                  </div>
                )}
                {fullRecord.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {fullRecord.tags.map(tag => (
                      <span key={tag} className="px-2 py-1 text-xs bg-port-border rounded text-gray-400">{tag}</span>
                    ))}
                  </div>
                )}
                <div className="text-xs text-gray-500 flex flex-wrap gap-3">
                  {fullRecord.createdAt && <span>Created: {new Date(fullRecord.createdAt).toLocaleDateString()}</span>}
                  {fullRecord.nextAction && <span>Next: {fullRecord.nextAction}</span>}
                  {fullRecord.horizon && <span>Horizon: {fullRecord.horizon}</span>}
                  {fullRecord.targetDate && <span>Target: {fullRecord.targetDate}</span>}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-300">{selectedNode.summary}</p>
            )}
          </div>

          {connectedNodes.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-2">{connectedNodes.length} connections</p>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {connectedNodes.map(cn => (
                  <button
                    key={cn.id}
                    onClick={() => {
                      const node = graphRef.current?.idMap.get(cn.id);
                      if (node) setSelectedNode(node);
                    }}
                    onDoubleClick={() => focusNode(cn)}
                    title="Click to select · double-click to explore its connections"
                    className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-port-border/50 transition-colors"
                  >
                    <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: BRAIN_TYPE_HEX[cn.brainType] }} />
                    <span className="text-xs text-gray-300 truncate flex-1">{cn.label}</span>
                    <span className="text-[10px] text-gray-600 shrink-0">
                      {cn.edgeType === 'linked' ? 'linked' : cn.edgeType === 'shared_tag' ? 'tag' : `${((cn.weight || 0) * 100).toFixed(0)}%`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
