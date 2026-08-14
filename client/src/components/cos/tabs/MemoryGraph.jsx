import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { Info } from 'lucide-react';
import * as api from '../../../services/api';
import { MEMORY_TYPES, MEMORY_TYPE_COLORS } from '../constants';
import { buildGraph } from '../../../lib/graphSimulation';
import BrailleSpinner from '../../BrailleSpinner';
import useHoverTooltip from '../../../hooks/useHoverTooltip';
import { formatDateNumeric } from '../../../utils/formatters';

// Widest the hover tooltip renders. Single source for both its max-width and
// the clamp that keeps it inside the viewport — as a CSS class plus a mirrored
// constant the two silently drift apart.
const TOOLTIP_WIDTH = 320;

const TYPE_HEX = {
  fact: '#3b82f6',
  learning: '#22c55e',
  observation: '#a855f7',
  decision: '#f97316',
  preference: '#ec4899',
  context: '#6b7280'
};

// --- Three.js scene components ---

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
      tmpColor.set(e.type === 'linked' ? '#3b82f6' : '#6b7280');
      const intensity = dimmed ? 0.06 : (e.type === 'linked' ? 0.6 * e.weight : 0.3 * e.weight);
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
        const color = TYPE_HEX[node.type] || '#6b7280';
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
            // Pass the enter event's coordinates up: the wrapper's onPointerMove
            // only tracks the cursor WHILE a node is hovered, so the tooltip's
            // first frame has to be placed from this event.
            onPointerOver={(e) => { e.stopPropagation(); onHover(node, { x: e.clientX, y: e.clientY }); }}
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

// --- Outer component ---

export default function MemoryGraph() {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState(null);
  const [fullMemory, setFullMemory] = useState(null);
  // Hover tooltip state + the ref-gated pointer tracking that keeps a plain
  // mouse move from re-rendering this component when nothing can paint.
  const { hoveredNode, tooltipPos, handleHover, handlePointerMove } = useHoverTooltip();
  const [layoutKey, setLayoutKey] = useState(0);
  // Mobile-only: the legend auto-shows on a roomy viewport (CSS, not this flag).
  const [legendOpen, setLegendOpen] = useState(false);

  const graphRef = useRef(null);
  const dragStartRef = useRef(null);

  useEffect(() => {
    api.getMemoryGraph().then(setGraphData).catch(() => setGraphData(null)).finally(() => setLoading(false));
  }, []);

  const graph = useMemo(() => {
    if (!graphData?.nodes?.length) return null;
    const g = buildGraph(graphData.nodes, graphData.edges);
    graphRef.current = g;
    return g;
  }, [graphData, layoutKey]);

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

  // Fetch full memory details when a node is selected
  useEffect(() => {
    if (!selectedNode) { setFullMemory(null); return; }
    let cancelled = false;
    api.getMemory(selectedNode.id).then(mem => {
      if (!cancelled) setFullMemory(mem);
    }).catch(() => {
      if (!cancelled) setFullMemory(null);
    });
    return () => { cancelled = true; };
  }, [selectedNode]);

  const handleSelect = useCallback((node) => {
    setSelectedNode(prev => prev?.id === node.id ? null : node);
  }, []);

  const handlePointerMissed = useCallback((e) => {
    const start = dragStartRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) < 5 && Math.abs(e.clientY - start.y) < 5) {
      setSelectedNode(null);
    }
  }, []);

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
        No memory graph data available. Add more memories to see relationships.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Stats bar */}
      <div className="flex items-center justify-between bg-port-card border border-port-border rounded-lg px-4 py-2">
        <span className="text-sm text-gray-400">
          {graphData.nodes.length} nodes &middot; {graphData.edges.length} connections
        </span>
        <button
          onClick={() => { setSelectedNode(null); setLayoutKey(k => k + 1); }}
          className="px-3 py-1.5 min-h-[36px] text-xs bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors"
        >
          Re-layout
        </button>
      </div>

      {/* 3D Canvas. Viewport-relative rather than a flat 500px: the canvas is a
          touch-action:none dead zone for page scrolling, so on a phone (and
          especially in landscape, where 500px overflowed the whole viewport) it
          has to leave room to scroll past. Caps at the original 500px on
          desktop, floors at 240px so it stays usable on a short viewport. */}
      <div
        className="relative bg-port-card border border-port-border rounded-lg overflow-hidden h-[clamp(240px,45vh,500px)]"
        onPointerDown={(e) => { dragStartRef.current = { x: e.clientX, y: e.clientY }; }}
        onPointerMove={handlePointerMove}
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
              onHover={handleHover}
            />
          </Canvas>
        )}

        {/* Legend. Its ~200px blankets a short canvas, so it auto-shows only on
            a `roomy-viewport` (wide AND tall — see index.css); otherwise it
            collapses behind a toggle and expands upward from the corner. The
            height half of that variant is what makes a landscape phone work: it
            is wider than `sm` but only ~390px tall, so a width-only rule
            force-showed the legend over a floored 240px canvas AND hid the
            toggle — blanketing the graph with no way out.
            (The edge colours exist nowhere else in this tab, hence a toggle
            rather than dropping the legend on small screens.) */}
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
            {MEMORY_TYPES.map(t => (
              <div key={t} className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TYPE_HEX[t] }} />
                <span className="text-gray-400">{t}</span>
              </div>
            ))}
            <div className="border-t border-port-border pt-1.5 mt-1.5 space-y-1">
              <div className="flex items-center gap-2">
                {/* Stays a fixed blue (not port-accent) to match GraphEdges' hardcoded
                    #3b82f6 three.js edge color below — theming just the legend would
                    desync it from the actual rendered edge color on non-blue themes. */}
                <span className="inline-block w-4 h-0 border-t border-blue-400" />
                <span className="text-gray-500">linked</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-4 h-0 border-t border-gray-500" />
                <span className="text-gray-500">similar</span>
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
            the user's own finger. Position is clamped so it can't run off the
            right edge of a narrow window, where `x + 12` alone would clip it. */}
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
              <span className={`px-1.5 py-0.5 text-[10px] rounded-full border ${MEMORY_TYPE_COLORS[hoveredNode.type] || 'border-port-border text-gray-400'}`}>
                {hoveredNode.type}
              </span>
              <span className="text-[10px] text-gray-500">{hoveredNode.category}</span>
            </div>
            <p className="text-xs text-white leading-snug">{hoveredNode.summary}</p>
            <p className="text-[10px] text-gray-500 mt-1">importance: {((hoveredNode.importance ?? 0.5) * 100).toFixed(0)}%</p>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedNode && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className={`px-2 py-1 text-xs rounded-full border ${MEMORY_TYPE_COLORS[selectedNode.type] || 'border-port-border text-gray-400'}`}>
                  {selectedNode.type}
                </span>
                <span className="text-xs text-gray-500">{selectedNode.category}</span>
                <span className="text-xs text-gray-500">importance: {((selectedNode.importance ?? 0.5) * 100).toFixed(0)}%</span>
              </div>
              {fullMemory ? (
                <div className="space-y-3">
                  <p className="text-sm text-white whitespace-pre-wrap">{fullMemory.content}</p>
                  {fullMemory.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {fullMemory.tags.map(tag => (
                        <span key={tag} className="px-2 py-1 text-xs bg-port-border rounded text-gray-400">{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-gray-500 flex flex-wrap gap-3">
                    <span>Created: {formatDateNumeric(fullMemory.createdAt)}</span>
                    {fullMemory.accessCount > 0 && <span>Accessed: {fullMemory.accessCount}x</span>}
                    {fullMemory.confidence != null && <span>Confidence: {(fullMemory.confidence * 100).toFixed(0)}%</span>}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-white">{selectedNode.summary}</p>
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
                    <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: TYPE_HEX[cn.type] }} />
                    <span className="text-xs text-gray-300 truncate flex-1">{cn.summary}</span>
                    <span className="text-[10px] text-gray-600 shrink-0">
                      {cn.edgeType === 'linked' ? 'linked' : `${(cn.weight * 100).toFixed(0)}%`}
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
