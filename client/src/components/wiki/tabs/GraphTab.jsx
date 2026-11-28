import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { getNotesVaultGraph } from '../../../services/apiNotes.js';
import { RefreshCw, Network, ZoomIn, ZoomOut } from 'lucide-react';
import { WIKI_CATEGORIES } from '../constants.jsx';
import BrailleSpinner from '../../BrailleSpinner';
import ListLoadError from '../../ui/ListLoadError';
import OfflineNotesNotice from '../../OfflineNotesNotice.jsx';
import useChartColors from '../../../hooks/useChartColors.js';
import useLatestRequest from '../../../hooks/useLatestRequest.js';

// Pointer travel under this is a tap (open note) rather than a pan.
const TAP_SLOP_PX = 6;
// Arrow-key pan distance in viewport pixels.
const KEY_PAN_STEP_PX = 40;
const PAN_KEYS = {
  ArrowUp: [0, KEY_PAN_STEP_PX],
  ArrowDown: [0, -KEY_PAN_STEP_PX],
  ArrowLeft: [KEY_PAN_STEP_PX, 0],
  ArrowRight: [-KEY_PAN_STEP_PX, 0]
};

export default function GraphTab({ vaultId }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canvasRef = useRef(null);
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [viewport, setViewport] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState(null);
  const nodesRef = useRef([]);
  const gestureRef = useRef(null);
  const connectionCountsRef = useRef(new Map());
  const beginLoad = useLatestRequest();
  const { text: labelColor, axis: mutedLabelColor } = useChartColors();
  const hasGraph = !loading && !loadFailed && Boolean(graphData?.totalNodes);

  const loadGraph = useCallback(async () => {
    const isCurrent = beginLoad();
    setLoading(true);
    setLoadFailed(false);
    const data = await getNotesVaultGraph(vaultId, { silent: true }).catch(() => null);
    if (!isCurrent()) return;
    const ok = Boolean(data) && !data.error;
    setLoadFailed(!ok);
    if (ok) {
      setGraphData(data);
      layoutNodes(data);
    } else {
      setGraphData(null);
      nodesRef.current = [];
    }
    setLoading(false);
  }, [vaultId, beginLoad]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const layoutNodes = (data) => {
    const { nodes, edges } = data;
    if (nodes.length === 0) return;

    // Pre-compute connection counts (O(E) instead of O(N*E) per render)
    const counts = new Map();
    for (const edge of edges) {
      counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
    }
    connectionCountsRef.current = counts;

    // Group by folder for clustered layout
    const groups = {};
    for (const node of nodes) {
      const group = node.folder?.split('/')[1] || 'root';
      if (!groups[group]) groups[group] = [];
      groups[group].push(node);
    }

    const groupKeys = Object.keys(groups);
    const centerX = 400;
    const centerY = 300;
    const groupRadius = 200;
    const positioned = [];

    groupKeys.forEach((group, gi) => {
      const angle = (gi / groupKeys.length) * Math.PI * 2;
      const gx = centerX + Math.cos(angle) * groupRadius;
      const gy = centerY + Math.sin(angle) * groupRadius;
      const items = groups[group];
      const nodeRadius = Math.min(80, items.length * 15);

      items.forEach((node, ni) => {
        const na = (ni / items.length) * Math.PI * 2;
        positioned.push({
          ...node,
          x: gx + Math.cos(na) * nodeRadius,
          y: gy + Math.sin(na) * nodeRadius,
          group
        });
      });
    });

    nodesRef.current = positioned;
  };

  // The canvas is mounted only when there is a graph to show.
  useEffect(() => {
    if (!hasGraph) return;
    const canvas = canvasRef.current;
    const measure = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      setViewport(prev => prev?.width === width && prev.height === height && prev.dpr === dpr
        ? prev
        : { width, height, dpr });
    };
    const wheelZoom = (event) => {
      event.preventDefault();
      setZoom(z => Math.max(0.3, Math.min(3, z - event.deltaY * 0.001)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    window.addEventListener('resize', measure);
    canvas.addEventListener('wheel', wheelZoom, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', wheelZoom);
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [hasGraph]);

  // Layout, interaction and drawing use CSS pixels. Scale only the backing store.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!hasGraph || !canvas || !viewport?.width || !viewport.height || nodesRef.current.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height, dpr } = viewport;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const nodes = nodesRef.current;
    const nodeMap = new Map(nodes.map(n => [n.path, n]));

    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(offset.x + width / 2 - 400, offset.y + height / 2 - 300);
    ctx.scale(zoom, zoom);

    // Draw edges
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.15)';
    ctx.lineWidth = 1;
    for (const edge of graphData.edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (source && target) {
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      }
    }

    // Draw nodes
    const colorMap = Object.fromEntries(WIKI_CATEGORIES.map(c => [c.key, c.hex]));
    colorMap.root = '#6b7280';

    for (const node of nodes) {
      const isHovered = hoveredNode === node.path;
      const color = colorMap[node.group] || colorMap.root;
      const radius = isHovered ? 7 : 5;

      const connections = connectionCountsRef.current.get(node.path) || 0;
      const nodeRadius = radius + Math.min(connections * 1.5, 6);

      ctx.beginPath();
      ctx.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? color : color + '99';
      ctx.fill();

      if (isHovered) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Label
      if (isHovered || zoom > 0.8) {
        ctx.font = `${isHovered ? 'bold ' : ''}${11 / zoom}px system-ui`;
        ctx.fillStyle = isHovered ? labelColor : mutedLabelColor;
        ctx.textAlign = 'center';
        ctx.fillText(node.name, node.x, node.y + nodeRadius + 12 / zoom);
      }
    }

    ctx.restore();
  }, [hasGraph, graphData, viewport, zoom, offset, hoveredNode, labelColor, mutedLabelColor]);

  // Graph-space hit test at a viewport point; null when no node is within reach.
  const hitTest = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas || nodesRef.current.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = (clientX - rect.left - offset.x - rect.width / 2 + 400) / zoom;
    const my = (clientY - rect.top - offset.y - rect.height / 2 + 300) / zoom;

    let closest = null;
    let minDist = 20;
    for (const node of nodesRef.current) {
      const dist = Math.hypot(node.x - mx, node.y - my);
      if (dist < minDist) {
        minDist = dist;
        closest = node.path;
      }
    }
    return closest;
  }, [zoom, offset]);

  const openNote = useCallback((path) => {
    const next = new URLSearchParams(searchParams);
    next.set('note', path);
    navigate({ pathname: '/wiki/browse', search: next.toString() });
  }, [navigate, searchParams]);

  const handlePointerDown = useCallback((e) => {
    // One gesture at a time: a second finger or mouse button must not hijack the active one.
    if (gestureRef.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gestureRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, panned: false };
  }, []);

  const handlePointerMove = useCallback((e) => {
    const gesture = gestureRef.current;
    if (gesture?.id === e.pointerId) {
      if (!gesture.panned && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) < TAP_SLOP_PX) return;
      if (!gesture.panned) setHoveredNode(null);
      gesture.panned = true;
      const dx = e.clientX - gesture.lastX;
      const dy = e.clientY - gesture.lastY;
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      e.currentTarget.style.cursor = 'grabbing';
      setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const closest = hitTest(e.clientX, e.clientY);
    setHoveredNode(closest);
    e.currentTarget.style.cursor = closest ? 'pointer' : 'grab';
  }, [hitTest]);

  const endGesture = useCallback((e, { allowTap }) => {
    const gesture = gestureRef.current;
    if (gesture?.id !== e.pointerId) return;
    if (allowTap && e.pointerType === 'mouse' && e.button !== 0) return;
    gestureRef.current = null;
    const hit = hitTest(e.clientX, e.clientY);
    if (e.pointerType === 'mouse') {
      setHoveredNode(hit);
      e.currentTarget.style.cursor = hit ? 'pointer' : 'grab';
    }
    if (allowTap && !gesture.panned && hit) openNote(hit);
  }, [hitTest, openNote]);

  const handlePointerUp = useCallback((e) => endGesture(e, { allowTap: true }), [endGesture]);
  const handlePointerCancel = useCallback((e) => endGesture(e, { allowTap: false }), [endGesture]);

  // Keyboard parity with the pointer handlers. The canvas is role="application", which the global
  // hotkey guard (shouldIgnoreGlobalKey) already yields to, so Space here never triggers push-to-talk.
  const handleKeyDown = useCallback((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const pan = PAN_KEYS[e.key];
    if (pan) {
      e.preventDefault();
      setOffset(prev => ({ x: prev.x + pan[0], y: prev.y + pan[1] }));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(z => Math.min(z + 0.2, 3));
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom(z => Math.max(z - 0.2, 0.3));
    } else if (e.key === '0') {
      e.preventDefault();
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    } else if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      const nodes = nodesRef.current;
      if (nodes.length === 0) return;
      const step = e.key === ']' ? 1 : -1;
      const current = nodes.findIndex(n => n.path === hoveredNode);
      const next = current === -1 ? (step === 1 ? 0 : nodes.length - 1) : (current + step + nodes.length) % nodes.length;
      setHoveredNode(nodes[next].path);
    } else if ((e.key === 'Enter' || e.key === ' ') && hoveredNode) {
      e.preventDefault();
      openNote(hoveredNode);
    }
  }, [hoveredNode, openNote]);

  const activeNode = hoveredNode ? nodesRef.current.find(n => n.path === hoveredNode) : null;

  if (loading) {
    return (
      <div className="w-full flex-1 flex items-center justify-center p-4">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="w-full p-4">
        <ListLoadError what="the knowledge graph" onRetry={loadGraph} />
      </div>
    );
  }

  if (!hasGraph) {
    return (
      <div className="w-full flex-1 flex flex-col items-center justify-center p-4 text-gray-500">
        <Network size={32} className="mb-2 opacity-30" />
        <p className="text-sm">No pages to graph yet</p>
      </div>
    );
  }

  return (
    <div className="relative w-full flex-1 min-h-0 overflow-hidden">
      {/* Controls */}
      <div className="absolute inset-x-4 top-4 z-10 flex flex-col items-end gap-2 pointer-events-none">
        <div className="flex flex-wrap items-center justify-end gap-2 max-w-full pointer-events-auto">
          <span className="text-xs text-gray-500">{graphData.totalNodes} nodes, {graphData.totalEdges} edges</span>
          <button
            type="button"
            onClick={() => setZoom(z => Math.min(z + 0.2, 3))}
            aria-label="Zoom in"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded bg-port-card border border-port-border text-gray-400 hover:text-white"
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(z => Math.max(z - 0.2, 0.3))}
            aria-label="Zoom out"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded bg-port-card border border-port-border text-gray-400 hover:text-white"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}
            className="min-h-[44px] px-2 py-1 rounded bg-port-card border border-port-border text-gray-400 hover:text-white text-xs"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={loadGraph}
            aria-label="Refresh"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded bg-port-card border border-port-border text-gray-400 hover:text-white"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <OfflineNotesNotice count={graphData.skippedUnavailable} className="w-full max-w-md pointer-events-auto" />
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 right-4 sm:right-auto z-10 bg-port-card/90 border border-port-border rounded-lg p-3 flex flex-wrap gap-3 text-xs">
        {WIKI_CATEGORIES.map(cat => (
          <span key={cat.key} className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cat.hex }} />
            <span className="text-gray-400">{cat.label}</span>
          </span>
        ))}
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {activeNode
          ? `${activeNode.name}, ${activeNode.group}, ${connectionCountsRef.current.get(activeNode.path) || 0} connections. Press Enter to open.`
          : ''}
      </div>

      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="Knowledge graph. Arrow keys pan, plus and minus zoom, zero resets, left and right brackets cycle pages, Enter opens the selected page."
        onKeyDown={handleKeyDown}
        className="block w-full h-full touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHoveredNode(null); }}
      />
    </div>
  );
}
