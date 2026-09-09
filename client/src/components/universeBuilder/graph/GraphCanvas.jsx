/**
 * The Universe Builder graph canvas: force/radial/timeline layout, pan + zoom,
 * node drag, hover tooltip and selection.
 *
 * Positions live on the node objects the parent hands down (the simulation
 * mutates them in place), so toggling a filter or switching layout keeps the
 * graph where the user left it instead of re-scattering it.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Maximize2, Minus, Plus } from 'lucide-react';
import {
  GRAPH_KINDS, GRAPH_KIND_ORDER, edgeDef, hexToRgba, kindDef, nodeInitials,
} from '../../../lib/universeGraphModel';
import {
  applyAnchors, computeFit, hitTest, radiusFor, seedPositions, settleLayout,
  stepLayout, timelineGeometry, toScreen,
} from '../../../lib/universeGraphLayout';

const ALPHA_MIN = 0.003;
const ZOOM_STEP = 1.3;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;
// A drag under this many pixels is a click, not a pan — otherwise a slightly
// shaky click on a node never selects it.
const CLICK_SLOP_PX = 3;

const LABELLED_KINDS = new Set(['character', 'place', 'series']);

function drawGraph(ctx, {
  view, width, height, nodes, edges, degree, match, adjacency,
  selectedId, hoveredId, timeIndex, layout, totalIssues, series, issues, kinds, dpr,
}) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const ghost = (node) => timeIndex != null && (node.firstIssue || 0) > timeIndex;
  const highlightId = selectedId || hoveredId;
  const near = highlightId
    ? new Set([highlightId, ...(adjacency.get(highlightId) || [])
      .map((e) => (e.source === highlightId ? e.target : e.source))])
    : null;

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  if (layout === 'timeline' && totalIssues > 0) {
    // Series bands + kind lane labels sit under the nodes so the strip reads
    // as a chart rather than a scatter.
    const { width: TW, laneHeight, top } = timelineGeometry;
    ctx.font = `${11 / view.k}px -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    series.forEach((s, i) => {
      const own = issues.filter((x) => x.seriesId === s.id);
      if (!own.length) return;
      const x0 = (own[0].index / totalIssues) * TW - TW / 2;
      const x1 = ((own[own.length - 1].index + 1) / totalIssues) * TW - TW / 2;
      ctx.fillStyle = hexToRgba(GRAPH_KINDS.series.color, 0.05 + (i % 2) * 0.03);
      ctx.fillRect(x0, top - 50, x1 - x0, GRAPH_KIND_ORDER.length * laneHeight + 100);
      ctx.fillStyle = '#6b7280';
      ctx.fillText(s.name, x0 + 6, top - 34);
    });
    GRAPH_KIND_ORDER.forEach((kind, lane) => {
      if (!kinds.has(kind)) return;
      ctx.fillStyle = hexToRgba(GRAPH_KINDS[kind].color, 0.5);
      ctx.fillText(GRAPH_KINDS[kind].label, -TW / 2 - 150, lane * laneHeight + top + 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath();
      ctx.moveTo(-TW / 2 - 150, lane * laneHeight + top + 30);
      ctx.lineTo(TW / 2 + 60, lane * laneHeight + top + 30);
      ctx.stroke();
    });
  }

  ctx.lineCap = 'round';
  for (const edge of edges) {
    const def = edgeDef(edge.type);
    let alpha = def.group === 'relationship' ? 0.7 : def.group === 'attachment' ? 0.45 : 0.22;
    if (near) {
      alpha = near.has(edge.source) && near.has(edge.target)
        && (edge.source === highlightId || edge.target === highlightId) ? 0.95 : 0.05;
    }
    if (ghost(edge.sourceNode) || ghost(edge.targetNode)
      || (timeIndex != null && (edge.since || 0) > timeIndex)) alpha *= 0.15;
    if (match && !(match.has(edge.source) || match.has(edge.target))) alpha *= 0.2;
    ctx.strokeStyle = hexToRgba(def.color, alpha);
    ctx.lineWidth = (def.group === 'relationship' ? 1.6 : def.group === 'appearance' ? 1 : 0.7) / Math.sqrt(view.k);
    ctx.setLineDash(def.dashed ? [4 / view.k, 4 / view.k] : []);
    ctx.beginPath();
    ctx.moveTo(edge.sourceNode.x, edge.sourceNode.y);
    if (def.group === 'relationship') {
      // Bow typed links so a mutual pair draws as two arcs, not one line.
      const mx = (edge.sourceNode.x + edge.targetNode.x) / 2;
      const my = (edge.sourceNode.y + edge.targetNode.y) / 2;
      const dx = edge.targetNode.x - edge.sourceNode.x;
      const dy = edge.targetNode.y - edge.sourceNode.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const off = Math.min(18, d * 0.12);
      ctx.quadraticCurveTo(mx - (dy / d) * off, my + (dx / d) * off, edge.targetNode.x, edge.targetNode.y);
    } else ctx.lineTo(edge.targetNode.x, edge.targetNode.y);
    ctx.stroke();
    if (edge.directed && alpha > 0.3) {
      const dx = edge.targetNode.x - edge.sourceNode.x;
      const dy = edge.targetNode.y - edge.sourceNode.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const r = radiusFor(edge.targetNode, degree.get(edge.target) || 0) + 2;
      const ax = edge.targetNode.x - (dx / d) * r;
      const ay = edge.targetNode.y - (dy / d) * r;
      const size = 5 / Math.sqrt(view.k);
      ctx.fillStyle = hexToRgba(def.color, alpha);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - (dx / d) * size - (dy / d) * size * 0.6, ay - (dy / d) * size + (dx / d) * size * 0.6);
      ctx.lineTo(ax - (dx / d) * size + (dy / d) * size * 0.6, ay - (dy / d) * size - (dx / d) * size * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.setLineDash([]);

  // Labels are placed in screen space and culled on overlap, highest priority
  // first — otherwise a dense cast renders as a wall of overlapping names.
  const labelFont = `${11 / view.k}px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
  const placed = [];
  const labelFits = (node, r) => {
    ctx.font = labelFont;
    const w = ctx.measureText(node.name).width * view.k + 6;
    const [sx, sy] = toScreen(view, node.x, node.y + r);
    const rect = { x0: sx - w / 2, y0: sy + 2, x1: sx + w / 2, y1: sy + 16 };
    const pinned = node.id === selectedId || node.id === hoveredId;
    if (!pinned && placed.some((p) => rect.x0 < p.x1 && rect.x1 > p.x0 && rect.y0 < p.y1 && rect.y1 > p.y0)) return false;
    placed.push(rect);
    return true;
  };
  const priority = (node) => {
    if (node.id === selectedId || node.id === hoveredId) return 3;
    if ((near && near.has(node.id)) || (match && match.has(node.id))) return 2;
    return 0;
  };
  const ordered = nodes.slice().sort((a, b) =>
    priority(b) - priority(a) || (degree.get(b.id) || 0) - (degree.get(a.id) || 0));

  const labelPass = [];
  for (const node of ordered) {
    const color = kindDef(node.kind).color;
    const r = radiusFor(node, degree.get(node.id) || 0);
    let alpha = 1;
    if (near && !near.has(node.id)) alpha = 0.18;
    if (match && !match.has(node.id)) alpha = Math.min(alpha, 0.15);
    const isGhost = ghost(node);
    if (isGhost) alpha *= 0.25;
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;

    if (node.kind === 'image' || node.kind === 'composite' || node.kind === 'moodboard') {
      ctx.fillStyle = hexToRgba(color, alpha * 0.85);
      ctx.strokeStyle = hexToRgba('#ffffff', alpha * 0.35);
      ctx.lineWidth = 0.8 / view.k;
      const rr = r * 1.1;
      ctx.beginPath();
      ctx.roundRect(node.x - rr, node.y - rr, rr * 2, rr * 2, 1.5);
      ctx.fill();
      ctx.stroke();
    } else {
      if (node.hasImage) {
        const g = ctx.createRadialGradient(node.x - r * 0.35, node.y - r * 0.35, r * 0.1, node.x, node.y, r);
        g.addColorStop(0, hexToRgba('#ffffff', alpha * 0.35));
        g.addColorStop(0.5, hexToRgba(color, alpha * 0.9));
        g.addColorStop(1, hexToRgba(color, alpha * 0.55));
        ctx.fillStyle = g;
      } else ctx.fillStyle = hexToRgba(color, alpha * 0.28);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = (node.hasImage ? 1.6 : 1.2) / Math.sqrt(view.k);
      ctx.strokeStyle = hexToRgba(color, alpha);
      if (isGhost) ctx.setLineDash([2 / view.k, 3 / view.k]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (node.kind === 'character' && r * view.k > 9) {
        ctx.fillStyle = hexToRgba('#ffffff', alpha * (node.hasImage ? 0.95 : 0.75));
        ctx.font = `600 ${Math.max(6, r * 0.85)}px -apple-system, Segoe UI, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(nodeInitials(node.name), node.x, node.y + 0.5);
      }
    }
    if (node.locked) {
      ctx.fillStyle = hexToRgba('#2563eb', alpha);
      ctx.beginPath();
      ctx.arc(node.x + r * 0.75, node.y - r * 0.75, 2.2 / Math.sqrt(view.k), 0, Math.PI * 2);
      ctx.fill();
    }
    if (isSelected || isHovered) {
      ctx.strokeStyle = isSelected ? '#ffffff' : hexToRgba('#ffffff', 0.6);
      ctx.lineWidth = 2 / view.k;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 3.5 / view.k, 0, Math.PI * 2);
      ctx.stroke();
    }
    const wantsLabel = isSelected || isHovered
      || (near && near.has(node.id)) || (match && match.has(node.id))
      || node.kind === 'character' || (LABELLED_KINDS.has(node.kind) && view.k > 0.75)
      || view.k > 1.6;
    if (wantsLabel && alpha > 0.2 && labelFits(node, r)) labelPass.push([node, r, alpha, isSelected]);
  }
  for (const [node, r, alpha, isSelected] of labelPass) {
    ctx.font = (isSelected ? '600 ' : '') + labelFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ly = node.y + r + 3 / view.k;
    ctx.lineWidth = 3 / view.k;
    ctx.strokeStyle = 'rgba(30,30,30,0.85)';
    ctx.lineJoin = 'round';
    ctx.strokeText(node.name, node.x, ly);
    ctx.fillStyle = isSelected
      ? '#ffffff'
      : hexToRgba(node.kind === 'issue' || node.kind === 'image' ? '#6b7280' : '#d1d5db', alpha);
    ctx.fillText(node.name, node.x, ly);
  }
  ctx.restore();
}

export default function GraphCanvas({
  index, visible, layout, kinds, selectedId, hoveredId, focusId, timeIndex,
  loading, statsLabel, resetToken, onSelect, onHover, onFocus,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const alphaRef = useRef(1);
  const dragRef = useRef(null);
  // Seeded false, not true: every mount path below calls markDirty() before the
  // first frame, so an initial `true` would be a second, redundant source of
  // truth for "needs a repaint".
  const dirtyRef = useRef(false);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const fitPendingRef = useRef(true);
  const seededRef = useRef(null);
  const settledRef = useRef(false);
  const [cursor, setCursor] = useState('grab');
  const [tip, setTip] = useState(null);
  const [legendOpen, setLegendOpen] = useState(true);

  // Everything the draw + step passes need, refreshed each render without
  // restarting the animation loop.
  const frame = useRef({});
  frame.current = { index, visible, layout, kinds, selectedId, hoveredId, timeIndex };

  const markDirty = useCallback(() => { dirtyRef.current = true; }, []);

  const fit = useCallback(() => {
    const { width, height } = sizeRef.current;
    viewRef.current = computeFit(visible.nodes, { width, height, layout });
    markDirty();
  }, [visible.nodes, layout, markDirty]);

  // Seed once per loaded graph, re-anchor on every layout switch, then settle
  // synchronously so the first paint shows a resolved shape rather than an
  // expanding blob. Re-seeding is deliberately per-GRAPH: a filter change must
  // not scatter the layout the user has been reading.
  useLayoutEffect(() => {
    if (seededRef.current !== index) {
      seededRef.current = index;
      seedPositions(index.nodes);
    }
    applyAnchors(index.nodes, layout, { totalIssues: index.totalIssues });
    settleLayout(visible.nodes, visible.edges, { layout, degree: visible.degree });
    alphaRef.current = 0;
    fitPendingRef.current = true;
    settledRef.current = true;
    markDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, layout]);

  // A filter / focus change re-heats the simulation gently and refits — but not
  // in the same commit the effect above already settled, or the first paint
  // would immediately jiggle out of the shape it just resolved to.
  useEffect(() => {
    if (settledRef.current) { settledRef.current = false; return; }
    alphaRef.current = Math.max(alphaRef.current, 0.5);
    fitPendingRef.current = true;
    markDirty();
  }, [visible.nodes, visible.edges, focusId, markDirty]);

  useEffect(() => { markDirty(); }, [selectedId, hoveredId, timeIndex, markDirty]);

  // "Reset view" from the toolbar — refit on the next frame rather than
  // reaching into the canvas from the parent.
  useEffect(() => {
    if (!resetToken) return;
    fitPendingRef.current = true;
    markDirty();
  }, [resetToken, markDirty]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (!width || !height) return;
      sizeRef.current = { width, height, dpr };
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      fitPendingRef.current = true;
      markDirty();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [markDirty]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const { width, height, dpr } = sizeRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !width) return;
      const f = frame.current;
      if (alphaRef.current > ALPHA_MIN) {
        alphaRef.current = stepLayout(f.visible.nodes, f.visible.edges, {
          alpha: alphaRef.current,
          layout: f.layout,
          degree: f.visible.degree,
          dragId: dragRef.current?.node?.id || null,
          aspect: Math.min(2, width / height),
        });
        markDirty();
        if (fitPendingRef.current && alphaRef.current < 0.01) {
          fitPendingRef.current = false;
          viewRef.current = computeFit(f.visible.nodes, { width, height, layout: f.layout });
        }
      } else if (fitPendingRef.current) {
        fitPendingRef.current = false;
        viewRef.current = computeFit(f.visible.nodes, { width, height, layout: f.layout });
        markDirty();
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      drawGraph(ctx, {
        view: viewRef.current,
        width,
        height,
        dpr,
        nodes: f.visible.nodes,
        edges: f.visible.edges,
        degree: f.visible.degree,
        match: f.visible.match,
        adjacency: f.index.adjacency,
        selectedId: f.selectedId,
        hoveredId: f.hoveredId,
        timeIndex: f.timeIndex,
        layout: f.layout,
        totalIssues: f.index.totalIssues,
        series: f.index.series,
        issues: f.index.issues,
        kinds: f.kinds,
      });
    };
    loop();
    return () => cancelAnimationFrame(raf);
    // markDirty is a stable useCallback, so listing it can't restart the loop.
  }, [markDirty]);

  const pointAt = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const zoomAt = useCallback((sx, sy, factor) => {
    const view = viewRef.current;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
    const ratio = k / view.k;
    viewRef.current = { k, x: sx - (sx - view.x) * ratio, y: sy - (sy - view.y) * ratio };
    markDirty();
  }, [markDirty]);

  // React routes wheel through a passive root listener, so preventDefault has
  // to come from a native non-passive listener on the canvas itself.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0015));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const handleDown = (event) => {
    const [sx, sy] = pointAt(event);
    const node = hitTest(visible.nodes, viewRef.current, sx, sy, visible.degree);
    dragRef.current = { sx, sy, x0: viewRef.current.x, y0: viewRef.current.y, node, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCursor('grabbing');
  };

  const handleMove = (event) => {
    const [sx, sy] = pointAt(event);
    const drag = dragRef.current;
    if (drag) {
      const dx = sx - drag.sx;
      const dy = sy - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP_PX) drag.moved = true;
      if (drag.node) {
        const view = viewRef.current;
        drag.node.x = (sx - view.x) / view.k;
        drag.node.y = (sy - view.y) / view.k;
        drag.node.tx = drag.node.x;
        drag.node.ty = drag.node.y;
        alphaRef.current = Math.max(alphaRef.current, 0.3);
      } else {
        viewRef.current = { ...viewRef.current, x: drag.x0 + dx, y: drag.y0 + dy };
      }
      markDirty();
      return;
    }
    const node = hitTest(visible.nodes, viewRef.current, sx, sy, visible.degree);
    setTip(node ? { x: sx, y: sy, node } : null);
    setCursor(node ? 'pointer' : 'grab');
    if ((node?.id || null) !== hoveredId) onHover(node?.id || null);
  };

  const handleUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    setCursor(drag.node ? 'pointer' : 'grab');
    if (!drag.moved) onSelect(drag.node ? drag.node.id : null);
    markDirty();
  };

  const handleLeave = () => {
    dragRef.current = null;
    setTip(null);
    setCursor('grab');
    if (hoveredId) onHover(null);
  };

  const handleDoubleClick = (event) => {
    const [sx, sy] = pointAt(event);
    const node = hitTest(visible.nodes, viewRef.current, sx, sy, visible.degree);
    if (node) onFocus(node.id);
  };

  const legendKinds = useMemo(
    () => GRAPH_KIND_ORDER.filter((k) => kinds.has(k)).map((k) => ({ id: k, ...GRAPH_KINDS[k] })),
    [kinds],
  );

  const tipNode = tip?.node;

  return (
    <div
      ref={wrapRef}
      className="relative flex-1 min-w-0 min-h-[380px] bg-port-card border border-port-border rounded-lg overflow-hidden"
      style={{ cursor }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
        style={{ touchAction: 'none' }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerLeave={handleLeave}
        onDoubleClick={handleDoubleClick}
      />
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-port-bg/60 text-sm text-gray-400">
          <Loader2 size={16} className="animate-spin" /> Building graph…
        </div>
      )}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 pointer-events-none">
        <span className="port-media-overlay px-2.5 py-1 text-[11px] rounded-lg">{statsLabel}</span>
        {focusId && (
          <button
            type="button"
            onClick={() => onFocus(null)}
            className="pointer-events-auto px-2.5 py-1 text-[11px] rounded-lg bg-port-accent/20 border border-port-accent/30 text-port-accent"
          >
            Focused on {index.byId.get(focusId)?.name || 'node'} · clear
          </button>
        )}
      </div>
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(sizeRef.current.width / 2, sizeRef.current.height / 2, ZOOM_STEP)} className="port-media-overlay port-media-overlay-item w-8 h-8 flex items-center justify-center rounded-lg"><Plus size={14} /></button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(sizeRef.current.width / 2, sizeRef.current.height / 2, 1 / ZOOM_STEP)} className="port-media-overlay port-media-overlay-item w-8 h-8 flex items-center justify-center rounded-lg"><Minus size={14} /></button>
        <button type="button" aria-label="Fit to view" onClick={fit} className="port-media-overlay port-media-overlay-item w-8 h-8 flex items-center justify-center rounded-lg"><Maximize2 size={14} /></button>
      </div>
      <div className="absolute bottom-3 left-3 z-10 max-w-[70%] flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => setLegendOpen((open) => !open)}
          aria-pressed={legendOpen}
          className="port-media-overlay port-media-overlay-item self-start px-2 py-0.5 text-[10px] rounded"
        >
          {legendOpen ? 'Hide legend' : 'Legend'}
        </button>
        {legendOpen && (
          <div className="port-media-overlay flex flex-wrap gap-x-3 gap-y-1 px-2 py-1.5 rounded-lg pointer-events-none">
            {legendKinds.map((k) => (
              <span key={k.id} className="inline-flex items-center gap-1.5 text-[11px]">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: k.color }} />
                {k.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {tipNode && (
        <div
          className="port-media-overlay absolute z-30 pointer-events-none rounded-lg px-2.5 py-2 min-w-[160px] max-w-[260px]"
          style={{ left: tip.x, top: tip.y, transform: 'translate(12px, 12px)' }}
        >
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: kindDef(tipNode.kind).color }} />
            {tipNode.name}
          </div>
          <div className="text-[11px] opacity-80 mt-0.5">{tipNode.role}</div>
          <div className="text-[11px] opacity-60 mt-1">
            {kindDef(tipNode.kind).singular} · {visible.degree.get(tipNode.id) || 0} visible links
          </div>
        </div>
      )}
    </div>
  );
}
