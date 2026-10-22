/**
 * FableLoom canvas — the visual editor for one episode's scene graph.
 *
 * Renders scene nodes as SVG cards with intent-labeled decision edges and
 * compact, unlabeled automatic cuts. Placement, orientation, and orthogonal
 * routing come from `layoutLoomGraph`; selection, card drag, pan and zoom come
 * from the shared `GraphCanvas`.
 * The canvas measures itself for card wrapping. Flow direction comes from
 * the parent when it knows the page breakpoint (editor rail beside vs
 * under); otherwise `pickLoomOrientation` keys off canvas width.
 * Click (or tap) selects a scene (selection lives in the URL — the parent
 * navigates); mouse-drag repositions a card and persists `pos` on release.
 * On the stacked layout no card claims a drag — its coordinates are not the
 * desktop space `pos` lives in — so the whole surface pans. Selecting a scene
 * dims every edge that doesn't touch it, and on the stacked layout a path
 * strip lists the inbound/outbound intents so a dense graph stays traversable
 * without tracing overlapping strokes.
 */

import { useId, useMemo } from 'react';
import { Flag, Play } from 'lucide-react';
import useContainerWidth from '../../hooks/useContainerWidth';
import {
  layoutLoomGraph, LOOM_EDGE_LABEL_MAX, LOOM_ORIENTATION,
} from '../../lib/loomLayout';
import GraphCanvas from '../graphCanvas/GraphCanvas';
import LoomSceneMedia from './LoomSceneMedia';

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
  onAutomateFalVideo,
  generationDisabled = false, generationDisabledReason = '',
}) {
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

  if (!nodes.length) return null;

  const titleMax = Math.max(12, Math.floor((nodeW - 20) / 7.2));
  const accentMarker = `loom-arrow-accent-${markerId}`;
  const mutedMarker = `loom-arrow-${markerId}`;

  const showStrip = stacked && selectedNodeId && byId.has(selectedNodeId);

  const renderEdges = () => edges.map((edge) => {
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
  });

  const renderNode = (node, { selected }) => {
    const isStart = node.id === episode.startNodeId;
    return (
      <>
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
        <g transform={`translate(10, ${nodeH - 13})`} className="pointer-events-none">
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
            y={nodeH - 12}
            textAnchor="end"
            className={node.playbackMode === 'cut'
              ? 'fill-port-accent text-[9px] font-medium pointer-events-none'
              : 'fill-port-warning text-[9px] font-medium pointer-events-none'}
          >
            {node.playbackMode === 'cut' ? 'Auto cut' : 'Decision loop'}
          </text>
        )}
      </>
    );
  };

  return (
    <div ref={measureRef} className="h-full w-full">
      <GraphCanvas
        width={layout.width}
        height={layout.height}
        nodes={nodes}
        positions={positions}
        nodeW={nodeW}
        nodeH={nodeH}
        selectedId={selectedNodeId}
        canDragNodes={!stacked}
        onSelect={onSelectNode}
        onMove={onMoveNode}
        ariaLabel="Episode scene graph"
        nodeLabel={(node) => `Scene: ${node.title || 'Untitled'}`}
        surfaceProps={{ 'data-testid': 'loom-canvas', 'data-orientation': orientation }}
        surfaceClassName={showStrip ? 'pb-28' : ''}
        renderDefs={() => (
          <>
            <marker id={mutedMarker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,1 L8,4 L0,7 Z" className="fill-port-border" />
            </marker>
            <marker id={accentMarker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,1 L8,4 L0,7 Z" className="fill-port-accent" />
            </marker>
          </>
        )}
        renderEdges={renderEdges}
        renderNode={renderNode}
        htmlInset={{ x: 8, y: 24, width: nodeW - 16, height: nodeH - 52 }}
        renderNodeHtml={(node) => (
          <LoomSceneMedia
            node={node}
            jobs={mediaJobs[node.id]}
            onGenerateImage={onGenerateImage}
            onGenerateVideo={onGenerateVideo}
            onAutomateFalVideo={onAutomateFalVideo}
            compact
            generationDisabled={generationDisabled}
            generationDisabledReason={generationDisabledReason}
          />
        )}
      >
        {showStrip && (
          <PathStrip
            episode={episode}
            node={byId.get(selectedNodeId)}
            byId={byId}
            onSelectNode={onSelectNode}
          />
        )}
      </GraphCanvas>
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
