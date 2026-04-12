import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../../../services/api';
import { RefreshCw, Network, ZoomIn, ZoomOut } from 'lucide-react';
import { WIKI_CATEGORIES } from '../constants.jsx';

export default function GraphTab({ vaultId }) {
  const navigate = useNavigate();
  const canvasRef = useRef(null);
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [hoveredNode, setHoveredNode] = useState(null);
  const nodesRef = useRef([]);
  const connectionCountsRef = useRef(new Map());

  const loadGraph = useCallback(async () => {
    setLoading(true);
    const data = await api.getNotesVaultGraph(vaultId).catch(() => null);
    if (data && !data.error) {
      setGraphData(data);
      layoutNodes(data);
    }
    setLoading(false);
  }, [vaultId]);

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

  // Render graph on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graphData || nodesRef.current.length === 0) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const nodes = nodesRef.current;
    const nodeMap = new Map(nodes.map(n => [n.path, n]));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(offset.x + canvas.width / 2 - 400, offset.y + canvas.height / 2 - 300);
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
        ctx.fillStyle = isHovered ? '#ffffff' : '#9ca3af';
        ctx.textAlign = 'center';
        ctx.fillText(node.name, node.x, node.y + nodeRadius + 12 / zoom);
      }
    }

    ctx.restore();
  }, [graphData, zoom, offset, hoveredNode]);

  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas || nodesRef.current.length === 0) return;

    if (dragging) {
      setOffset(prev => ({
        x: prev.x + e.movementX,
        y: prev.y + e.movementY
      }));
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - offset.x - canvas.width / 2 + 400) / zoom;
    const my = (e.clientY - rect.top - offset.y - canvas.height / 2 + 300) / zoom;

    let closest = null;
    let minDist = 20;
    for (const node of nodesRef.current) {
      const dist = Math.hypot(node.x - mx, node.y - my);
      if (dist < minDist) {
        minDist = dist;
        closest = node.path;
      }
    }
    setHoveredNode(closest);
    canvas.style.cursor = closest ? 'pointer' : dragging ? 'grabbing' : 'grab';
  }, [dragging, zoom, offset]);

  const handleClick = useCallback(() => {
    if (hoveredNode) {
      navigate('/wiki/browse', { state: { openNote: hoveredNode } });
    }
  }, [hoveredNode, navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  if (!graphData || graphData.totalNodes === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500">
        <Network size={32} className="mb-2 opacity-30" />
        <p className="text-sm">No pages to graph yet</p>
      </div>
    );
  }

  return (
    <div className="relative -m-4" style={{ height: 'calc(100vh - 220px)' }}>
      {/* Controls */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <span className="text-xs text-gray-500">{graphData.totalNodes} nodes, {graphData.totalEdges} edges</span>
        <button
          onClick={() => setZoom(z => Math.min(z + 0.2, 3))}
          className="p-1.5 rounded bg-port-card border border-port-border text-gray-400 hover:text-white"
        >
          <ZoomIn size={14} />
        </button>
        <button
          onClick={() => setZoom(z => Math.max(z - 0.2, 0.3))}
          className="p-1.5 rounded bg-port-card border border-port-border text-gray-400 hover:text-white"
        >
          <ZoomOut size={14} />
        </button>
        <button
          onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}
          className="px-2 py-1 rounded bg-port-card border border-port-border text-gray-400 hover:text-white text-xs"
        >
          Reset
        </button>
        <button onClick={loadGraph} className="p-1.5 rounded bg-port-card border border-port-border text-gray-400 hover:text-white">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 bg-port-card/90 border border-port-border rounded-lg p-3 flex flex-wrap gap-3 text-xs">
        {WIKI_CATEGORIES.map(cat => (
          <span key={cat.key} className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cat.hex }} />
            <span className="text-gray-400">{cat.label}</span>
          </span>
        ))}
      </div>

      <canvas
        ref={canvasRef}
        className="w-full h-full"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onMouseDown={() => { if (!hoveredNode) setDragging(true); }}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => { setDragging(false); setHoveredNode(null); }}
        onWheel={(e) => {
          e.preventDefault();
          setZoom(z => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
        }}
      />
    </div>
  );
}
