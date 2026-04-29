import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { RefreshCw, Search, AlertTriangle, Zap } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import { BRAIN_TYPE_HEX, DESTINATIONS } from '../constants';
import { buildGraph } from '../../../lib/graphSimulation';
import BrailleSpinner from '../../BrailleSpinner';

const EDGE_COLORS = {
  similar: '#3b82f6',
  shared_tag: '#f59e0b',
  linked: '#ffffff'
};

const BRAIN_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories'];

// Per-type API getters for detail panel
const TYPE_GETTERS = {
  people: api.getBrainPerson,
  projects: api.getBrainProject,
  ideas: api.getBrainIdea,
  admin: api.getBrainAdminItem,
  memories: api.getBrainMemory
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

function GraphScene({ graph, selectedId, adjacentIds, onSelect, onHover }) {
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
  const [selectedNode, setSelectedNode] = useState(null);
  const [fullRecord, setFullRecord] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [layoutKey, setLayoutKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [typeFilters, setTypeFilters] = useState(() =>
    Object.fromEntries(BRAIN_TYPES.map(t => [t, true]))
  );

  const graphRef = useRef(null);
  const dragStartRef = useRef(null);

  useEffect(() => {
    api.getBrainGraph().then(setGraphData).catch(() => setGraphData(null)).finally(() => setLoading(false));
  }, []);

  // Filter nodes based on type toggles and search
  const filteredData = useMemo(() => {
    if (!graphData?.nodes?.length) return null;
    const query = searchQuery.toLowerCase();
    const filteredNodes = graphData.nodes.filter(n => {
      if (!typeFilters[n.brainType]) return false;
      if (query && !n.label.toLowerCase().includes(query) && !n.summary?.toLowerCase().includes(query)) return false;
      return true;
    });
    const nodeIds = new Set(filteredNodes.map(n => n.id));
    const filteredEdges = graphData.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
    return { nodes: filteredNodes, edges: filteredEdges };
  }, [graphData, typeFilters, searchQuery]);

  const graph = useMemo(() => {
    if (!filteredData?.nodes?.length) return null;
    const g = buildGraph(filteredData.nodes, filteredData.edges);
    graphRef.current = g;
    return g;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutKey intentionally triggers rebuild on re-layout
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

  const handlePointerMissed = useCallback((e) => {
    const start = dragStartRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) < 5 && Math.abs(e.clientY - start.y) < 5) {
      setSelectedNode(null);
    }
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    const stats = await api.syncBrainData().catch(err => {
      toast.error(err.message || 'Sync failed');
      return null;
    });
    setSyncing(false);
    if (stats) {
      toast.success(`Synced ${stats.synced} records (${stats.skipped} skipped)`);
      // Reload graph data to pick up new embeddings
      const fresh = await api.getBrainGraph().catch(() => null);
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

  if (!graphData || !graphData.nodes?.length) {
    return (
      <div className="text-center py-12 text-gray-500">
        No brain entities to graph. Add people, projects, ideas, admin items, or memories to see relationships.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* No-embeddings banner */}
      {graphData && !graphData.hasEmbeddings && (
        <div className="flex items-center justify-between bg-port-warning/10 border border-port-warning/30 rounded-lg px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-port-warning">
            <AlertTriangle size={16} />
            No embeddings found. Sync brain data to CoS memory to enable semantic similarity edges.
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-port-warning/20 text-port-warning border border-port-warning/30 rounded-lg hover:bg-port-warning/30 transition-colors disabled:opacity-50"
          >
            {syncing ? <BrailleSpinner /> : <Zap size={14} />}
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      )}

      {/* Controls bar */}
      <div className="flex items-center gap-3 bg-port-card border border-port-border rounded-lg px-4 py-2 flex-wrap">
        {/* Type filter checkboxes */}
        <div className="flex items-center gap-3">
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

        {/* Search */}
        <div className="flex-1 min-w-[140px] max-w-xs relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter nodes..."
            className="w-full bg-port-bg border border-port-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
          />
        </div>

        {/* Stats + re-layout */}
        <span className="text-sm text-gray-400 ml-auto">
          {filteredData?.nodes?.length || 0} nodes &middot; {filteredData?.edges?.length || 0} edges
        </span>
        <button
          onClick={() => { setSelectedNode(null); setLayoutKey(k => k + 1); }}
          className="px-3 py-1.5 min-h-[36px] text-xs bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors"
        >
          Re-layout
        </button>
      </div>

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
              onHover={handleHover}
            />
          </Canvas>
        )}

        {!graph && filteredData?.nodes?.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            No nodes match the current filters.
          </div>
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
                  {(fullRecord.context || fullRecord.oneLiner || fullRecord.notes || fullRecord.content) && (
                    <p className="text-sm text-gray-300 whitespace-pre-wrap">
                      {fullRecord.context || fullRecord.oneLiner || fullRecord.notes || fullRecord.content}
                    </p>
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
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-300">{selectedNode.summary}</p>
              )}
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-gray-500 hover:text-white transition-colors p-1 shrink-0"
            >
              &times;
            </button>
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
