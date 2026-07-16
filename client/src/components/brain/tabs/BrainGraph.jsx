import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {AlertTriangle, Zap, RefreshCw, X, ChevronRight, ArrowLeft, Compass} from 'lucide-react';
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

function GraphScene({ graph, selectedId, adjacentIds, onSelect, onFocus, onHover }) {
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
}

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
        <div className="flex items-center justify-between bg-port-warning/10 border border-port-warning/30 rounded-lg px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-port-warning">
            <AlertTriangle size={16} />
            No embeddings found. Sync brain data to CoS memory to enable semantic similarity edges.
          </div>
          <button
            onClick={() => handleSync({ onlyMissing: true })}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-port-warning/20 text-port-warning border border-port-warning/30 rounded-lg hover:bg-port-warning/30 transition-colors disabled:opacity-50"
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
          items={searchIndex.map(n => ({ id: n.id, name: n.label, subtitle: DESTINATIONS[n.brainType]?.label || n.brainType }))}
          value={searchValue}
          onChange={setSearchValue}
          onPick={(item) => { focusNode({ id: item.id, label: item.name }); setSearchValue(''); }}
          inputId="brain-graph-search"
          noun="memory"
          placeholder="Search memories to explore…"
          className="flex-1 min-w-[200px]"
        />
        {missingCount > 0 && (
          <button
            onClick={() => handleSync({ onlyMissing: true })}
            disabled={syncing}
            title={`${missingCount} of ${embeddingStatus?.total ?? '?'} records have no embedding yet — embed just those (fast)`}
            className="flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs whitespace-nowrap bg-port-warning/15 text-port-warning border border-port-warning/30 rounded-lg hover:bg-port-warning/25 transition-colors disabled:opacity-50"
          >
            {syncing ? <BrailleSpinner /> : <Zap size={14} />}
            {missingCount} missing · Embed
          </button>
        )}
      </div>

      {/* Breadcrumb trail + controls bar */}
      <div className="flex items-center gap-3 bg-port-card border border-port-border rounded-lg px-4 py-2 flex-wrap">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-xs min-w-0">
          {focusTrail.length > 0 && (
            <button
              onClick={goBack}
              title="Back"
              aria-label="Back"
              className="flex items-center gap-1 px-2 py-1 text-gray-400 hover:text-white rounded transition-colors"
            >
              <ArrowLeft size={13} />
            </button>
          )}
          <button
            onClick={goToOverview}
            disabled={focusTrail.length === 0}
            className={`px-1.5 py-1 rounded transition-colors ${focusTrail.length === 0 ? 'text-white font-medium' : 'text-gray-400 hover:text-white'}`}
          >
            Overview
          </button>
          {focusTrail.map((entry, i) => (
            <span key={entry.id} className="flex items-center gap-1 min-w-0">
              <ChevronRight size={12} className="text-gray-600 shrink-0" />
              <span className={`px-1 truncate max-w-[140px] ${i === focusTrail.length - 1 ? 'text-white font-medium' : 'text-gray-500'}`}>
                {entry.label}
              </span>
            </span>
          ))}
        </div>

        {/* Type filter checkboxes */}
        <div className="flex items-center gap-3 ml-auto">
          {BRAIN_TYPES.map(type => {
            const dest = DESTINATIONS[type];
            return (
              <label key={type} className="flex items-center gap-1.5 cursor-pointer text-sm">
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

        {/* Stats + re-layout */}
        <span className="text-sm text-gray-400">
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

      {/* 3D Canvas */}
      <div
        className="relative bg-port-card border border-port-border rounded-lg overflow-hidden"
        style={{ height: '500px' }}
        onPointerDown={(e) => { dragStartRef.current = { x: e.clientX, y: e.clientY }; }}
        onPointerMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
      >
        {graph && (
          <Canvas
            camera={{ position: [0, 0, 80], fov: 50 }}
            dpr={[1, 1.5]}
            style={{ background: '#0f0f0f' }}
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

        {/* Legend */}
        <div className="absolute bottom-3 left-3 bg-port-bg/90 border border-port-border rounded-lg p-3 text-xs space-y-1.5 pointer-events-none">
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

        {/* Tooltip */}
        {hoveredNode && (
          <div
            className="fixed z-50 pointer-events-none bg-port-bg border border-port-border rounded-lg px-3 py-2 shadow-lg max-w-xs"
            style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 12 }}
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
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
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
            <div className="flex flex-col items-end gap-2 shrink-0">
              <button
                onClick={() => setSelectedNode(null)}
                title="Clear selection (Esc)"
                aria-label="Clear selection"
                className="text-gray-500 hover:text-white transition-colors p-1"
              >
                &times;
              </button>
              {selectedNode.id !== focusId && (
                <button
                  onClick={() => focusNode(selectedNode)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-port-accent/20 text-port-accent border border-port-accent/30 rounded-lg hover:bg-port-accent/30 transition-colors whitespace-nowrap"
                >
                  <Compass size={13} />
                  Explore connections
                </button>
              )}
            </div>
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
