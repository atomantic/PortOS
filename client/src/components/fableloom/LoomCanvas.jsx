/**
 * FableLoom canvas — the visual editor for one episode's scene graph.
 *
 * Renders scene nodes as SVG cards with intent-labeled decision edges and
 * compact, unlabeled automatic cuts. Placement, orientation, and orthogonal
 * routing come from `layoutLoomGraph`.
 * The canvas measures itself for card wrapping. Flow direction comes from
 * the parent when it knows the page breakpoint (editor rail beside vs
 * under); otherwise `pickLoomOrientation` keys off canvas width.
 * Click (or tap) selects a scene (selection lives in the URL — the parent
 * navigates); mouse-drag repositions a card and persists `pos` on release.
 * Touch never drags — it would fight scrolling, and desktop `pos` is the
 * wrong coordinate space for the stacked layout. Selecting a scene dims
 * every edge that doesn't touch it, and on the stacked layout a path strip
 * lists the inbound/outbound intents so a dense graph stays traversable
 * without tracing overlapping strokes.
 */

import { useEffect, useId, useMemo, useRef } from 'react';
import { Flag, Play } from 'lucide-react';
import useContainerWidth from '../../hooks/useContainerWidth';
import {
  layoutLoomGraph, LOOM_EDGE_LABEL_MAX, LOOM_ORIENTATION,
} from '../../lib/loomLayout';
import LoomSceneMedia from './LoomSceneMedia';

const DRAG_THRESHOLD_PX = 4;

const truncate = (text, max) => {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const startOfPath = (d) => {
  const match = /^M\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(d || '');
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
};

export default function LoomCanvas({
  episode, selectedNodeId, onSelectNode, onMoveNode,
  viewportWidth: viewportWidthProp, orientation: orientationProp,
  mediaJobs = {}, onGenerateImage, onGenerateVideo,
  onOpenFalVideo,
  generationDisabled = false, generationDisabledReason = '',
}) {
  // An in-flight drag lives entirely outside React state: the dragged <g>'s
  // transform is mutated directly per pointermove, and the position commits
  // once on release. Routing it through setState re-rendered every node card
  // (each with a foreignObject media surface) ~60×/s. Edges catch up on release.
  const dragRef = useRef(null);
  const cardRefs = useRef(new Map());
  const mediaRefs = useRef(new Map());
  const [measureRef, measuredWidth] = useContainerWidth();
  const viewportWidth = viewportWidthProp ?? measuredWidth;
  const markerId = useId().replace(/:/g, '');

  const layout = useMemo(
    () => layoutLoomGraph(episode, { viewportWidth, orientation: orientationProp }),
    [episode, viewportWidth, orientationProp],
  );
  const { positions, edges, nodeW, nodeH, orientation } = layout;
  const stacked = orientation === LOOM_ORIENTATION.TB;

  const nodes = episode?.nodes || [];
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  useEffect(() => {
    if (!selectedNodeId || !measureRef.current) return undefined;
    const el = measureRef.current.querySelector(`[data-node-id="${selectedNodeId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return undefined;
  }, [selectedNodeId, measureRef, layout.width, layout.height]);

  const handlePointerDown = (event, node) => {
    if (event.button !== 0) return;
    // Touch/pen: tap-to-select only. Capturing the pointer would steal the
    // scroll gesture, and a stacked layout's coordinates must not persist as
    // desktop `pos`.
    if (event.pointerType !== 'mouse' || stacked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = positions[node.id] || { x: 0, y: 0 };
    dragRef.current = {
      id: node.id,
      cardEl: cardRefs.current.get(node.id),
      mediaEl: mediaRefs.current.get(node.id),
      startX: event.clientX,
      startY: event.clientY,
      originX: start.x,
      originY: start.y,
      x: start.x,
      y: start.y,
      moved: false,
    };
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    drag.x = Math.max(0, drag.originX + dx);
    drag.y = Math.max(0, drag.originY + dy);
    drag.cardEl?.setAttribute('transform', `translate(${drag.x}, ${drag.y})`);
    // Media foreignObjects are deliberately NOT children of the transformed
    // card group. Move their absolute coordinates in lockstep while dragging.
    drag.mediaEl?.setAttribute('x', drag.x + 8);
    drag.mediaEl?.setAttribute('y', drag.y + 24);
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved) {
      if (drag.cardEl) drag.cardEl.dataset.loomDragged = '1';
      if (drag.mediaEl) drag.mediaEl.dataset.loomDragged = '1';
      onMoveNode?.(drag.id, { x: Math.round(drag.x), y: Math.round(drag.y) });
    }
  };

  const handleNodeActivate = (event, nodeId) => {
    // A completed mouse-drag fires click on the card too — ignore that one so
    // repositioning doesn't also select (and so we don't persist stacked-layout
    // coordinates as desktop `pos` via a follow-up navigate).
    if (event?.currentTarget?.dataset?.loomDragged === '1') {
      delete event.currentTarget.dataset.loomDragged;
      return;
    }
    onSelectNode?.(nodeId);
  };

  if (!nodes.length) return null;

  const { width, height } = layout;
  const titleMax = Math.max(12, Math.floor((nodeW - 20) / 7.2));
  const accentMarker = `loom-arrow-accent-${markerId}`;
  const mutedMarker = `loom-arrow-${markerId}`;

  const showStrip = stacked && selectedNodeId && byId.has(selectedNodeId);

  return (
    <div className="relative h-full w-full">
      <div
        ref={measureRef}
        className={`overflow-auto h-full w-full overscroll-contain ${showStrip ? 'pb-28' : ''}`}
        data-testid="loom-canvas"
        data-orientation={orientation}
      >
        <svg
          width={width}
          height={height}
          className="block select-none"
          aria-label="Episode scene graph"
        >
        <defs>
          <marker id={mutedMarker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,1 L8,4 L0,7 Z" className="fill-port-border" />
          </marker>
          <marker id={accentMarker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,1 L8,4 L0,7 Z" className="fill-port-accent" />
          </marker>
        </defs>
        <g>
          {edges.map((edge) => {
            // With a scene selected, its own edges come forward and the rest
            // recede — the only way to read one path through a dense graph.
            const connected = edge.sourceId === selectedNodeId || edge.targetId === selectedNodeId;
            const outgoing = edge.sourceId === selectedNodeId;
            const start = startOfPath(edge.d);
            return (
              <g key={edge.id} className={!selectedNodeId ? 'opacity-80' : connected ? 'opacity-100' : 'opacity-20'}>
                <path
                  d={edge.d}
                  fill="none"
                  strokeWidth={connected ? 2.25 : 1.5}
                  markerEnd={`url(#${outgoing || (!selectedNodeId && connected) ? accentMarker : mutedMarker})`}
                  className={outgoing ? 'stroke-port-accent' : 'stroke-port-border'}
                />
                {/* Invisible fat stroke so a label-less jog is still easy to hover/tap. */}
                <path
                  d={edge.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={16}
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectNode?.(edge.targetId);
                  }}
                />
                {edge.intent && edge.showLabel !== false && (
                  <text
                    x={edge.labelX}
                    y={edge.labelY}
                    textAnchor="middle"
                    role="button"
                    tabIndex={0}
                    aria-label={`Path: ${edge.intent}`}
                    style={{ paintOrder: 'stroke' }}
                    strokeWidth={4}
                    strokeLinejoin="round"
                    className="fill-port-text-muted stroke-port-bg text-[10px] cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectNode?.(edge.targetId);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectNode?.(edge.targetId);
                      }
                    }}
                  >
                    {truncate(edge.intent, LOOM_EDGE_LABEL_MAX)}
                  </text>
                )}
                {outgoing && start && (
                  <circle cx={start.x} cy={start.y} r={3} className="fill-port-accent" />
                )}
              </g>
            );
          })}
        </g>
        <g>
          {nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            const selected = node.id === selectedNodeId;
            const isStart = node.id === episode.startNodeId;
            return (
              <g
                key={node.id}
                ref={(element) => {
                  if (element) cardRefs.current.set(node.id, element);
                  else cardRefs.current.delete(node.id);
                }}
                data-node-id={node.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                className={stacked ? 'cursor-pointer' : 'cursor-grab'}
                role="button"
                tabIndex={0}
                aria-label={`Scene: ${node.title || 'Untitled'}`}
                aria-current={selected ? 'true' : undefined}
                onPointerDown={(e) => handlePointerDown(e, node)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onClick={(e) => handleNodeActivate(e, node.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectNode?.(node.id);
                  }
                }}
              >
                <rect
                  width={nodeW}
                  height={nodeH}
                  rx={10}
                  strokeWidth={selected ? 2.5 : 1}
                  className={`${node.isEnding ? 'fill-port-success/10' : 'fill-port-card'} ${
                    selected ? 'stroke-port-accent' : 'stroke-port-border'
                  }`}
                />
                <text x={10} y={17} className="fill-port-text text-[11px] font-semibold pointer-events-none">
                  {truncate(node.title || 'Untitled scene', titleMax)}
                </text>
                <g transform={`translate(10, ${nodeH - 16})`} className="pointer-events-none">
                  {isStart && (
                    <g>
                      <Play size={10} className="text-port-accent" x={0} y={-8} />
                      <text x={14} y={1} className="fill-port-accent text-[9px] font-medium">Opening</text>
                    </g>
                  )}
                  {node.isEnding && (
                    <g transform={isStart ? 'translate(64, 0)' : ''}>
                      <Flag size={10} className="text-port-success" x={0} y={-8} />
                      <text x={14} y={1} className="fill-port-success text-[9px] font-medium">
                        {truncate(node.endingLabel || 'Ending', 20)}
                      </text>
                    </g>
                  )}
                </g>
                {!node.isEnding && (
                  <text
                    x={nodeW - 10}
                    y={nodeH - 15}
                    textAnchor="end"
                    className={node.playbackMode === 'cut'
                      ? 'fill-port-accent text-[9px] font-medium pointer-events-none'
                      : 'fill-port-warning text-[9px] font-medium pointer-events-none'}
                  >
                    {node.playbackMode === 'cut' ? 'Auto cut' : 'Decision loop'}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        {/* WebKit/iOS paints HTML inside a foreignObject at the wrong place
            when an ancestor SVG group is transformed. Keep each media surface
            at the SVG root and give it already-resolved canvas coordinates so
            images and videos stay inside their scene card on every engine. */}
        <g>
          {nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            return (
              <foreignObject
                key={node.id}
                ref={(element) => {
                  if (element) mediaRefs.current.set(node.id, element);
                  else mediaRefs.current.delete(node.id);
                }}
                data-node-media-id={node.id}
                x={pos.x + 8}
                y={pos.y + 24}
                width={nodeW - 16}
                height={nodeH - 48}
                onPointerDown={(event) => handlePointerDown(event, node)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onClick={(event) => handleNodeActivate(event, node.id)}
              >
                <div className="h-full w-full min-w-0 overflow-hidden" xmlns="http://www.w3.org/1999/xhtml">
                  <LoomSceneMedia
                    node={node}
                    jobs={mediaJobs[node.id]}
                    onGenerateImage={onGenerateImage}
                    onGenerateVideo={onGenerateVideo}
                    onOpenFalVideo={onOpenFalVideo}
                    compact
                    generationDisabled={generationDisabled}
                    generationDisabledReason={generationDisabledReason}
                  />
                </div>
              </foreignObject>
            );
          })}
        </g>
        </svg>
      </div>
      {showStrip && (
        <PathStrip
          episode={episode}
          node={byId.get(selectedNodeId)}
          byId={byId}
          onSelectNode={onSelectNode}
        />
      )}
    </div>
  );
}

/**
 * Compact inbound/outbound list for the stacked (phone) layout — tracing an
 * orthogonal path with a finger is how the desktop graph became unreadable
 * on small screens; tapping a named intent is the traversal that survives.
 */
function PathStrip({ episode, node, byId, onSelectNode }) {
  const outgoing = (node.transitions || []).filter((t) => byId.has(t.targetNodeId));
  const incoming = episode.nodes.flatMap((n) => (
    (n.transitions || [])
      .filter((t) => t.targetNodeId === node.id)
      .map((t) => ({ from: n, tr: t }))
  ));
  return (
    <div
      className="absolute bottom-0 inset-x-0 border-t border-port-border bg-port-card/95 backdrop-blur-sm px-3 py-2 space-y-1.5"
      data-testid="loom-path-strip"
    >
      <p className="text-[11px] font-semibold truncate">{node.title || 'Untitled scene'}</p>
      {incoming.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-port-text-muted shrink-0">From</span>
          {incoming.map(({ from, tr }) => (
            <button
              key={`in-${from.id}-${tr.id}`}
              type="button"
              onClick={() => onSelectNode?.(from.id)}
              className="text-[10px] px-2 py-0.5 rounded-full border border-port-border hover:border-port-accent max-w-full truncate"
            >
              {from.title || 'Untitled'}
              {tr.intent ? ` · ${truncate(tr.intent, 22)}` : ''}
            </button>
          ))}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-port-text-muted shrink-0">To</span>
          {outgoing.map((tr) => (
            <button
              key={tr.id}
              type="button"
              onClick={() => onSelectNode?.(tr.targetNodeId)}
              className="text-[10px] px-2 py-0.5 rounded-full border border-port-accent/40 text-port-accent hover:border-port-accent max-w-full truncate"
            >
              {truncate(tr.intent || 'continue', 22)}
              {' → '}
              {byId.get(tr.targetNodeId)?.title || 'Untitled'}
            </button>
          ))}
        </div>
      )}
      {incoming.length === 0 && outgoing.length === 0 && (
        <p className="text-[10px] text-port-text-muted">No paths in or out of this scene.</p>
      )}
    </div>
  );
}
