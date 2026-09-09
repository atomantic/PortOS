/**
 * Filter + view controls above the universe graph canvas: search, layout,
 * per-kind and per-edge-group visibility, and the two panel toggles.
 */

import { AlertTriangle, Image, Search } from 'lucide-react';
import {
  GRAPH_EDGE_GROUPS, GRAPH_KINDS, GRAPH_KIND_ORDER, edgeDef, hexToRgba,
} from '../../../lib/universeGraphModel';
import { GRAPH_LAYOUTS } from '../../../lib/universeGraphLayout';

// One representative edge type per group, so a group pill takes the colour of
// the family of links it toggles.
const GROUP_SAMPLE_TYPE = { relationship: 'ally' };
const groupColor = (groupId) => edgeDef(GROUP_SAMPLE_TYPE[groupId] || groupId).color;

export default function GraphToolbar({
  search, onSearchChange, layout, onLayoutChange, kinds, onToggleKind,
  groups, onToggleGroup, kindCounts, gapCount, gapsOpen, onToggleGaps,
  onOpenPoster, onResetView,
}) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg px-4 py-2 flex flex-wrap items-center gap-3">
      <div className="relative">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        <label htmlFor="universe-graph-search" className="sr-only">Search nodes</label>
        <input
          id="universe-graph-search"
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search nodes…"
          className="w-[190px] box-border bg-port-bg border border-port-border rounded px-2 py-1.5 pl-6 text-white text-xs focus:outline-none focus:border-port-accent"
        />
      </div>

      <div className="flex items-center gap-1 bg-port-bg border border-port-border rounded-lg p-0.5" role="group" aria-label="Graph layout">
        {GRAPH_LAYOUTS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onLayoutChange(l.id)}
            aria-pressed={layout === l.id}
            className={`px-2.5 py-1 rounded-md text-xs border ${
              layout === l.id
                ? 'bg-port-accent/20 text-port-accent border-port-accent/30'
                : 'bg-transparent text-gray-400 border-transparent hover:text-white'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2.5" role="group" aria-label="Node kinds">
        {GRAPH_KIND_ORDER.filter((k) => kindCounts[k]).map((k) => {
          const on = kinds.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => onToggleKind(k)}
              aria-pressed={on}
              title={`${on ? 'Hide' : 'Show'} ${GRAPH_KINDS[k].label}`}
              className={`flex items-center gap-1.5 text-xs ${on ? 'text-gray-400' : 'text-gray-600'}`}
            >
              <span
                className="inline-block w-3 h-3 rounded-sm border-2"
                style={{ borderColor: GRAPH_KINDS[k].color, background: on ? GRAPH_KINDS[k].color : 'transparent' }}
              />
              {GRAPH_KINDS[k].label}
              <span className="text-[10px] text-gray-500">{kindCounts[k]}</span>
            </button>
          );
        })}
      </div>

      <div className="w-px h-5 bg-port-border" />

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Link types">
        {GRAPH_EDGE_GROUPS.map((g) => {
          const on = groups.has(g.id);
          const color = groupColor(g.id);
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => onToggleGroup(g.id)}
              aria-pressed={on}
              className="px-2 py-0.5 rounded-full text-[11px] border"
              style={on
                ? { background: hexToRgba(color, 0.15), color, borderColor: hexToRgba(color, 0.4) }
                : { background: 'transparent', color: '#4b5563', borderColor: '#2a2a2a' }}
            >
              {g.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onToggleGaps}
        aria-pressed={gapsOpen}
        className={`flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-lg border border-port-warning/30 text-port-warning ${
          gapsOpen ? 'bg-port-warning/30' : 'bg-port-warning/20'
        }`}
      >
        <AlertTriangle size={14} /> Gaps <span className="text-[10px] opacity-80">{gapCount}</span>
      </button>
      <button
        type="button"
        onClick={onOpenPoster}
        className="flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs rounded-lg bg-port-accent/20 text-port-accent border border-port-accent/30"
      >
        <Image size={14} /> Poster
      </button>
      <button
        type="button"
        onClick={onResetView}
        className="px-3 py-1.5 min-h-[36px] text-xs rounded-lg bg-port-bg text-gray-400 border border-port-border"
      >
        Reset view
      </button>
    </div>
  );
}
