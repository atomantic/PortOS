/**
 * FableLoom canvas — the visual editor for one episode's scene graph.
 *
 * Renders scene nodes as SVG cards with intent-labeled transition edges —
 * both the placement and the edge routing come from `layoutLoomGraph`, which
 * layers the graph, sends backward edges through return lanes under the cards,
 * and de-collides the labels. Click selects a scene (selection lives in the URL
 * — the parent navigates); drag repositions it and persists `pos` on release.
 * Selecting a scene dims every edge that doesn't touch it, so one path stays
 * readable in a dense graph. The wrapper owns scrolling in both axes so a wide
 * graph pans instead of clipping.
 */

import { useMemo, useRef } from 'react';
import { Play, Flag } from 'lucide-react';
import { layoutLoomGraph, LOOM_EDGE_LABEL_MAX, LOOM_NODE_W, LOOM_NODE_H } from '../../lib/loomLayout';

const DRAG_THRESHOLD_PX = 4;

const truncate = (text, max) => {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

export default function LoomCanvas({ episode, selectedNodeId, onSelectNode, onMoveNode }) {
  // An in-flight drag lives entirely outside React state: the dragged <g>'s
  // transform is mutated directly per pointermove, and the position commits
  // once on release. Routing it through setState re-rendered every node card
  // (each with a foreignObject subtree) ~60×/s. Edges catch up on release.
  const dragRef = useRef(null);

  const layout = useMemo(() => layoutLoomGraph(episode), [episode]);
  const { positions, edges } = layout;

  const nodes = episode?.nodes || [];

  const handlePointerDown = (event, node) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = positions[node.id] || { x: 0, y: 0 };
    dragRef.current = {
      id: node.id,
      el: event.currentTarget,
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
    drag.el.setAttribute('transform', `translate(${drag.x}, ${drag.y})`);
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved) {
      onMoveNode?.(drag.id, { x: Math.round(drag.x), y: Math.round(drag.y) });
    } else {
      onSelectNode?.(drag.id);
    }
  };

  if (!nodes.length) return null;

  const { width, height } = layout;

  return (
    <div className="overflow-auto h-full w-full" data-testid="loom-canvas">
      <svg width={width} height={height} className="block select-none touch-none">
        <g>
          {edges.map((edge) => {
            // With a scene selected, its own edges come forward and the rest
            // recede — the only way to read one path through a dense graph.
            const connected = edge.sourceId === selectedNodeId || edge.targetId === selectedNodeId;
            const outgoing = edge.sourceId === selectedNodeId;
            // Labels paint their stroke FIRST, which draws each one its own
            // background out of the page color — a path running under a label
            // then doesn't strike through the text.
            return (
              <g key={edge.id} className={!selectedNodeId ? 'opacity-70' : connected ? 'opacity-100' : 'opacity-25'}>
                <path d={edge.d} fill="none" strokeWidth={connected ? 2 : 1.5}
                  className={outgoing ? 'stroke-port-accent' : 'stroke-port-border'} />
                {edge.intent && (
                  <text x={edge.labelX} y={edge.labelY - 6} textAnchor="middle"
                    style={{ paintOrder: 'stroke' }} strokeWidth={3} strokeLinejoin="round"
                    className="fill-port-text-muted stroke-port-bg text-[10px] pointer-events-none">
                    {truncate(edge.intent, LOOM_EDGE_LABEL_MAX)}
                  </text>
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
                transform={`translate(${pos.x}, ${pos.y})`}
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`Scene: ${node.title || 'Untitled'}`}
                onPointerDown={(e) => handlePointerDown(e, node)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectNode?.(node.id);
                  }
                }}
              >
                <rect
                  width={LOOM_NODE_W}
                  height={LOOM_NODE_H}
                  rx={10}
                  strokeWidth={selected ? 2 : 1}
                  className={`${node.isEnding ? 'fill-port-success/10' : 'fill-port-card'} ${
                    selected ? 'stroke-port-accent' : 'stroke-port-border'
                  }`}
                />
                {node.image && (
                  <image
                    href={`/data/images/${node.image}`}
                    x={8} y={26} width={54} height={LOOM_NODE_H - 34}
                    preserveAspectRatio="xMidYMid slice"
                  />
                )}
                <text x={10} y={17} className="fill-port-text text-[11px] font-semibold pointer-events-none">
                  {truncate(node.title || 'Untitled scene', 26)}
                </text>
                <foreignObject x={node.image ? 68 : 10} y={24} width={LOOM_NODE_W - (node.image ? 78 : 20)} height={LOOM_NODE_H - 48}>
                  <div className="text-[10px] leading-snug text-port-text-muted overflow-hidden h-full pointer-events-none">
                    {truncate(node.prose, 110)}
                  </div>
                </foreignObject>
                <g transform={`translate(10, ${LOOM_NODE_H - 16})`} className="pointer-events-none">
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
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
