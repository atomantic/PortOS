/**
 * Right-hand panel of the Graph tab. Three mutually exclusive faces:
 * the gaps & enrichment list, the selected node's dossier, and — when nothing
 * is selected — a universe overview.
 */

import { AlertTriangle, Crosshair, Image, X } from 'lucide-react';
import {
  GAP_CATEGORIES, edgeDef, evolutionStageRows, hexToRgba, kindDef, nodeInitials,
} from '../../../lib/universeGraphModel';

const Section = ({ title, trailing, children }) => (
  <div>
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{title}</span>
      {trailing}
    </div>
    {children}
  </div>
);

const NodeRow = ({ node, meta, metaColor, onPick }) => (
  <li>
    <button
      type="button"
      onClick={() => onPick(node.id)}
      className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-port-bg text-xs text-gray-300"
    >
      <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: kindDef(node.kind).color }} />
      <span className="flex-1 min-w-0 truncate">{node.name}</span>
      {meta && <span className="text-[10px] whitespace-nowrap" style={metaColor ? { color: metaColor } : undefined}>{meta}</span>}
    </button>
  </li>
);

function GapsPanel({ gaps, category, onCategoryChange, counts, onPick, onClose }) {
  const shown = gaps.filter((g) => category === 'all' || g.cat === category).slice(0, 60);
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold text-white flex items-center gap-2">
          <AlertTriangle size={16} className="text-port-warning" /> Gaps &amp; enrichment
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close gaps"
          className="text-gray-500 hover:text-white -m-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {GAP_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onCategoryChange(c.id)}
            aria-pressed={category === c.id}
            className={`px-2 py-0.5 rounded-full text-[11px] border ${
              category === c.id
                ? 'bg-port-warning/20 text-port-warning border-port-warning/30'
                : 'bg-transparent text-gray-400 border-port-border'
            }`}
          >
            {c.label} <span className="opacity-70">{counts[c.id] || 0}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="m-0 text-xs text-gray-500">Nothing outstanding in this category.</p>
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
          {shown.map((gap) => (
            <li key={`${gap.cat}:${gap.nodeId}:${gap.otherId || ''}:${gap.title}`}>
              <button
                type="button"
                onClick={() => onPick(gap.nodeId)}
                className="w-full text-left flex gap-2.5 items-start p-2 rounded border border-port-border bg-port-bg/60 hover:bg-port-bg"
              >
                <span className="mt-1.5 inline-block w-2 h-2 rounded-full shrink-0" style={{ background: gap.color }} />
                <span className="min-w-0">
                  <span className="block text-xs text-white">{gap.title}</span>
                  <span className="block text-[11px] leading-[15px] text-gray-400 mt-0.5">{gap.detail}</span>
                  <span className="inline-block mt-1.5 text-[10px] uppercase tracking-wide" style={{ color: gap.color }}>{gap.action}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Overview({ index, stats, gapCount, topNodes, onPick }) {
  return (
    <>
      <h3 className="m-0 text-sm font-semibold text-white">{index.name}</h3>
      <p className="m-0 text-xs leading-[18px] text-gray-400">
        Click a node to inspect it. Drag to rearrange, scroll to zoom, double-click to focus a
        neighbourhood. Scrub the timeline to see the world as it stood at any issue.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="border border-port-border rounded px-2.5 py-2 bg-port-bg/60">
            <div className="text-lg font-semibold text-white tabular-nums">{stat.value}</div>
            <div className="text-[11px] text-gray-500">{stat.label}</div>
          </div>
        ))}
        <div className="border border-port-border rounded px-2.5 py-2 bg-port-bg/60">
          <div className="text-lg font-semibold text-white tabular-nums">{gapCount}</div>
          <div className="text-[11px] text-gray-500">Open gaps</div>
        </div>
      </div>
      <Section title="Most connected">
        <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
          {topNodes.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              meta={`${index.degree.get(node.id) || 0} links`}
              onPick={onPick}
            />
          ))}
        </ul>
      </Section>
    </>
  );
}

function Selection({
  index, node, timeIndex, gaps, onPick, onClear, onFocus, onDossierPoster,
}) {
  const links = index.adjacency.get(node.id) || [];
  const relationships = links.filter((e) => e.directed);
  const connected = links.filter((e) => !e.directed && e.type !== 'appearance' && e.type !== 'membership');
  const appearances = new Map();
  for (const i of index.appear[node.id] || []) {
    const issue = index.issues[i];
    if (issue) appearances.set(issue.seriesId, (appearances.get(issue.seriesId) || 0) + 1);
  }
  const isCanon = ['character', 'place', 'object'].includes(node.kind);
  const kind = kindDef(node.kind);
  const badges = [{ label: kind.singular, color: kind.color }];
  if (node.locked) badges.push({ label: 'locked', color: '#2563eb' });
  if (isCanon && !node.hasImage) badges.push({ label: 'no render', color: '#f59e0b' });
  if (timeIndex != null && (node.firstIssue || 0) > timeIndex) {
    badges.push({ label: 'not yet introduced', color: '#9ca3af' });
  }
  const ownGaps = gaps.filter((g) => g.nodeId === node.id || g.otherId === node.id);
  const sliders = node.sliders || null;
  const framework = node.framework || null;

  return (
    <>
      <div className="flex items-start gap-2.5">
        <div
          className="w-12 h-12 rounded shrink-0 flex items-center justify-center text-base font-semibold text-white border"
          style={{
            borderColor: kind.color,
            background: node.hasImage
              ? `linear-gradient(135deg, ${kind.color}, ${hexToRgba(kind.color, 0.35)})`
              : hexToRgba(kind.color, 0.18),
          }}
        >
          {nodeInitials(node.name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white leading-[18px] break-words">{node.name}</div>
          <div className="text-xs text-gray-400 mt-0.5">{node.role}</div>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {badges.map((b) => (
              <span
                key={b.label}
                className="px-1.5 py-px rounded-full text-[10px] border"
                style={{ color: b.color, borderColor: hexToRgba(b.color, 0.4), background: hexToRgba(b.color, 0.12) }}
              >
                {b.label}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Deselect"
          className="text-gray-500 hover:text-white -m-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => onFocus(node.id)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-port-accent/20 text-port-accent border border-port-accent/30"
        >
          <Crosshair size={12} /> Focus neighbourhood
        </button>
        {node.kind === 'character' && (
          <button
            type="button"
            onClick={() => onDossierPoster(node.id)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-port-bg text-gray-400 border border-port-border"
          >
            <Image size={12} /> Dossier poster
          </button>
        )}
      </div>

      {node.kind === 'character' && (
        <>
          <Section title="Three sliders">
            {sliders ? ['proactivity', 'likability', 'competence'].map((axis) => (
              <div key={axis} className="flex items-center gap-2 mb-1">
                <span className="w-[76px] text-[11px] text-gray-400 capitalize">{axis}</span>
                <span className="flex-1 h-1 rounded bg-port-border relative overflow-hidden">
                  <span
                    className="absolute left-0 top-0 bottom-0 bg-port-accent"
                    style={{ width: `${(sliders[axis] || 0) * 10}%` }}
                  />
                </span>
                <span className="w-4 text-right text-[11px] text-gray-300 tabular-nums">
                  {Number.isInteger(sliders[axis]) ? sliders[axis] : '—'}
                </span>
              </div>
            )) : <p className="m-0 text-xs text-gray-500">No axis rated yet.</p>}
          </Section>

          <Section
            title="Character framework"
            trailing={node.arcType ? <span className="text-[10px] text-gray-400">{node.arcType} arc</span> : null}
          >
            {framework ? ['ghost', 'wound', 'lie', 'need', 'want'].map((field) => (
              <div key={field} className="mb-1.5">
                <div className="text-[11px] text-gray-500 capitalize">{field}</div>
                <div className="text-xs leading-[17px] text-gray-300">{framework[field] || <span className="text-gray-600">Not authored</span>}</div>
              </div>
            )) : <p className="m-0 text-xs text-gray-500">No framework authored yet.</p>}
          </Section>

          <Section
            title="Evolution lens"
            trailing={<span className="text-[10px] text-purple-400">{node.evolution?.outcome || 'no lens'}</span>}
          >
            {node.evolution ? (
              <ol className="list-none m-0 p-0 flex flex-col">
                {evolutionStageRows(node.evolution).map((row, i, all) => (
                  <li key={row.stageId} className="flex gap-2.5 items-start">
                    <span className="flex flex-col items-center shrink-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full border-2 mt-[3px]"
                        style={{ borderColor: '#a855f7', background: row.authored ? '#a855f7' : 'transparent' }}
                      />
                      {i < all.length - 1 && <span className="w-px flex-1 min-h-[14px] bg-port-border" />}
                    </span>
                    <span className="pb-2 min-w-0">
                      <span className={`block text-xs leading-4 ${row.authored ? 'text-gray-300' : 'text-gray-500'}`}>{row.label}</span>
                      <span className="block text-[11px] text-gray-500">{row.authored ? 'authored' : 'not authored'}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="text-xs text-gray-500 border border-dashed border-port-border rounded p-2">
                No evolution lens authored yet.
              </div>
            )}
          </Section>

          <Section title="Relationships" trailing={<span className="text-[10px] text-gray-400">{relationships.length}</span>}>
            {relationships.length ? (
              <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
                {relationships.map((edge) => {
                  const other = edge.source === node.id ? edge.targetNode : edge.sourceNode;
                  const def = edgeDef(edge.type);
                  return (
                    <NodeRow
                      key={`${edge.source}:${edge.target}:${edge.type}`}
                      node={other}
                      meta={`${edge.source === node.id ? '→' : '←'} ${def.label}`}
                      metaColor={def.color}
                      onPick={onPick}
                    />
                  );
                })}
              </ul>
            ) : (
              <div className="text-xs text-gray-500 border border-dashed border-port-border rounded p-2">
                No typed relationships.
              </div>
            )}
          </Section>
        </>
      )}

      <Section title="Connected" trailing={<span className="text-[10px] text-gray-400">{connected.length}</span>}>
        {connected.length ? (
          <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
            {connected.map((edge) => {
              const other = edge.source === node.id ? edge.targetNode : edge.sourceNode;
              return (
                <NodeRow
                  key={`${edge.source}:${edge.target}:${edge.type}:${edge.label || ''}`}
                  node={other}
                  meta={edge.label || edgeDef(edge.type).label}
                  onPick={onPick}
                />
              );
            })}
          </ul>
        ) : (
          <p className="m-0 text-xs text-gray-500">Nothing attached.</p>
        )}
      </Section>

      {isCanon && (
        <Section title="Appears in">
          {appearances.size ? [...appearances.entries()].map(([seriesId, count]) => (
            <div key={seriesId} className="flex items-center gap-2 text-xs text-gray-300 py-0.5">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: kindDef('series').color }} />
              <span className="flex-1 min-w-0 truncate">{index.byId.get(seriesId)?.name || seriesId}</span>
              <span className="text-[10px] text-gray-500">{count} issue{count === 1 ? '' : 's'}</span>
            </div>
          )) : <p className="m-0 text-xs text-gray-500">Not yet used in any series.</p>}
        </Section>
      )}

      {ownGaps.length > 0 && (
        <Section title="Gaps on this node">
          {ownGaps.map((gap) => (
            <div
              key={`${gap.cat}:${gap.title}`}
              className="text-xs leading-4 text-gray-300 px-2 py-1.5 border border-port-warning/30 rounded mb-1"
            >
              {gap.title}
              <span className="block text-[11px] text-gray-400">{gap.detail}</span>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

export default function GraphInspector({
  index, selectedNode, timeIndex, gaps, gapCounts, gapsOpen, gapCategory,
  stats, topNodes, onPick, onClear, onFocus, onDossierPoster,
  onGapCategoryChange, onCloseGaps,
}) {
  return (
    <aside
      className="w-full lg:w-80 shrink-0 box-border bg-port-card border border-port-border rounded-lg px-4 py-3 overflow-y-auto max-h-[360px] lg:max-h-none flex flex-col gap-3"
      aria-label="Graph inspector"
    >
      {gapsOpen ? (
        <GapsPanel
          gaps={gaps}
          counts={gapCounts}
          category={gapCategory}
          onCategoryChange={onGapCategoryChange}
          onPick={onPick}
          onClose={onCloseGaps}
        />
      ) : selectedNode ? (
        <Selection
          index={index}
          node={selectedNode}
          timeIndex={timeIndex}
          gaps={gaps}
          onPick={onPick}
          onClear={onClear}
          onFocus={onFocus}
          onDossierPoster={onDossierPoster}
        />
      ) : (
        <Overview
          index={index}
          stats={stats}
          gapCount={gaps.length}
          topNodes={topNodes}
          onPick={onPick}
        />
      )}
    </aside>
  );
}
