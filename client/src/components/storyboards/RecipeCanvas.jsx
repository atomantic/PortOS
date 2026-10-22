import GraphCanvas from '../graphCanvas/GraphCanvas';
import { RECIPE_NODE_PORTS, RECIPE_PORT_LABELS } from '../../../../server/lib/storyboardRecipe.js';

export const RECIPE_NODE_W = 200;
const HEADER_H = 40;
const PORT_GAP = 24;
const nodeHeight = (node) => HEADER_H + Math.max(1, Object.keys(RECIPE_NODE_PORTS[node.type].inputs).length) * PORT_GAP + 12;
const inputY = (index) => HEADER_H + index * PORT_GAP + PORT_GAP / 2;
const NODE_H = Math.max(...Object.keys(RECIPE_NODE_PORTS).map((type) => nodeHeight({ type })));

const STATUS_FILL = { running: 'fill-port-warning', queued: 'fill-port-warning', done: 'fill-port-success', failed: 'fill-port-error' };

const curve = (a, b) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

/**
 * The desktop recipe canvas: nodes where the recipe placed them, wires as
 * curves from an output (right edge) to an input (left edge). Drag a card to
 * move it, drag from an output dot to an input dot to wire it, tap a card to
 * open it below. Selection is the caller's (`?node=` in the URL).
 */
export default function RecipeCanvas({ recipe, statusOf, selectedId, onSelect, onMove, onConnect }) {
  const positions = Object.fromEntries(recipe.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const width = Math.max(800, ...recipe.nodes.map((n) => n.x + RECIPE_NODE_W + 80));
  const height = Math.max(420, ...recipe.nodes.map((n) => n.y + NODE_H + 80));
  const byId = new Map(recipe.nodes.map((n) => [n.id, n]));

  const outPoint = (node) => ({ x: node.x + RECIPE_NODE_W, y: node.y + HEADER_H / 2 });
  const inPoint = (node, port) => {
    const index = Object.keys(RECIPE_NODE_PORTS[node.type].inputs).indexOf(port);
    return { x: node.x, y: node.y + inputY(Math.max(0, index)) };
  };

  return (
    <GraphCanvas
      width={width}
      height={height}
      nodes={recipe.nodes}
      positions={positions}
      nodeW={RECIPE_NODE_W}
      nodeH={NODE_H}
      selectedId={selectedId}
      onSelect={onSelect}
      onMove={onMove}
      onConnect={onConnect}
      ariaLabel="Recipe canvas"
      nodeLabel={(node) => `${node.title} (${node.type})`}
      surfaceClassName="rounded-lg border border-port-border bg-port-bg"
      renderEdges={() => recipe.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        return <path key={`${edge.from}-${edge.to}-${edge.toPort}`} d={curve(outPoint(from), inPoint(to, edge.toPort))} fill="none" strokeWidth={2} className="stroke-port-border" />;
      })}
      renderWireDraft={(a, b) => <path d={curve(a, b)} fill="none" strokeWidth={2} strokeDasharray="6 4" className="stroke-port-accent" />}
      renderNode={(node, { selected }) => {
        const inputs = Object.keys(RECIPE_NODE_PORTS[node.type].inputs);
        const h = nodeHeight(node);
        const fill = STATUS_FILL[statusOf(node.id)];
        return (
          <>
            <rect width={RECIPE_NODE_W} height={h} rx={10} strokeWidth={selected ? 2 : 1} className={`fill-port-card ${selected ? 'stroke-port-accent' : 'stroke-port-border'}`} />
            <text x={12} y={25} fontSize={13} fontWeight={600} className="fill-port-text">{node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}</text>
            {fill && <circle cx={RECIPE_NODE_W - 24} cy={HEADER_H / 2} r={4} className={fill} />}
            {inputs.map((port, index) => (
              <g key={port} data-port-in={port}>
                <circle cx={0} cy={inputY(index)} r={7} strokeWidth={1.5} className="fill-port-bg stroke-port-text-muted" />
                <text x={14} y={inputY(index) + 4} fontSize={11} className="fill-port-text-muted">{RECIPE_PORT_LABELS[port]}</text>
              </g>
            ))}
            {!inputs.length && <text x={12} y={inputY(0) + 4} fontSize={11} className="fill-port-text-muted">{node.type === 'references' ? 'Images' : 'Text'}</text>}
            {RECIPE_NODE_PORTS[node.type].output && (
              <circle data-port-out="true" cx={RECIPE_NODE_W} cy={HEADER_H / 2} r={8} strokeWidth={1.5} className="fill-port-accent stroke-port-bg cursor-crosshair">
                <title>Drag to an input to wire it</title>
              </circle>
            )}
          </>
        );
      }}
    />
  );
}
