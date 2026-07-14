import { useMemo, useState } from 'react';

import { RINGS, TRIBE_RINGS, ENERGY, STATUS_HEX, contactStatus, energyFor, initialsFor } from '../../lib/tribe.js';
import { clickableProps } from '../../lib/a11yKeyboard';

// Concentric-circles map of the Tribe: "Me" at the center, each Dunbar ring is a
// tinted band (support innermost → village outermost) and every person is a node
// placed inside their band. People classed `external` (former contacts, a nemesis)
// are NOT a ring — they fill the open canvas OUTSIDE the tribe perimeter (annulus
// + square corners), packed so the layout scales to a lot of them. Node fill
// encodes energy, the stroke encodes cadence status. Pure SVG — scales, prints,
// and works on mobile without a WebGL/canvas dependency.

const VIEW = 880;
const CENTER = VIEW / 2;
const HUB_R = 30; // the "Me" hub disk
const INNER_GAP = 54; // radius reserved around the hub before the first band
const EDGE_PAD = 16; // usable inset from the viewBox edge (external nodes stay inside this)
const DUNBAR_MAX = 290; // outer radius of the village ring = the tribe perimeter

// The map draws ONLY the four Dunbar rings; `external` is handled as the open
// outer region, not a band.
const DUNBAR = TRIBE_RINGS;
const RING_RADII = DUNBAR.map((_, i) => INNER_GAP + ((DUNBAR_MAX - INNER_GAP) * (i + 1)) / DUNBAR.length);
const VILLAGE_OUTER = RING_RADII[RING_RADII.length - 1];
const TRIBE_EDGE_INDEX = RING_RADII.length - 1; // village — its outer edge is the perimeter

// Node radius shrinks for the wider outer rings so they don't overlap.
const NODE_R = [15, 13, 11, 9];
const nodeRadius = (i) => NODE_R[i] ?? NODE_R[NODE_R.length - 1];

// Golden angle — successive nodes placed this far apart spread evenly (sunflower
// packing) instead of stacking into spokes.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Theme-reactive SVG colors. Hardcoded dark hexes washed out on the day themes
// (a near-white card with a dark label halo and pale-gray node text), so these
// resolve through the active theme's CSS variables instead. var() only evaluates
// in a CSS context, so these go through the `style` prop (via the helpers below),
// NOT as fill="…"/stroke="…" presentation attributes — see ScoreSheet.jsx for the
// same constraint and pattern.
const HALO = 'rgb(var(--port-card))'; // label outline = card bg, so it masks nodes without showing as an outline
const NODE_INK = 'rgb(var(--port-text))';
const MUTED_INK = 'rgb(var(--port-text-muted))';
const ACCENT = 'rgb(var(--port-accent))';
// Colour goes through `style`; geometry/opacity stay as attributes.
const fillStyle = (color, extra) => ({ fill: color, ...extra });
const strokeStyle = (color, extra) => ({ stroke: color, ...extra });

// Place node `slot` of `total` inside ring `ringIndex`'s annular band — the empty
// disk just inside its labeled circle — rather than on the ring line itself.
// Equal-area radius (sqrt-spaced) keeps the band evenly filled as a person count
// grows, so a crowded ring thickens into a cluster instead of cramming a line.
function nodePosition(ringIndex, slot, total) {
  const outerEdge = RING_RADII[ringIndex];
  const innerEdge = ringIndex === 0 ? INNER_GAP : RING_RADII[ringIndex - 1];
  const pad = nodeRadius(ringIndex) + 4; // keep nodes off the dashed boundary circles
  const rIn = innerEdge + pad;
  const rOut = Math.max(rIn, outerEdge - pad);
  const f = total <= 1 ? 0.5 : (slot + 0.5) / total;
  const radius = Math.sqrt(rIn * rIn + f * (rOut * rOut - rIn * rIn));
  // Per-ring phase so adjacent bands don't share a seam.
  const angle = slot * GOLDEN_ANGLE + ringIndex * 1.4;
  return {
    x: CENTER + Math.cos(angle) * radius,
    y: CENTER + Math.sin(angle) * radius,
  };
}

const EXTERNAL_GAP = 16; // clearance between the tribe perimeter and the nearest external node

// Lay out `total` external people across the open region outside the tribe
// perimeter — the annulus from the village edge to the canvas, including the four
// square corners. A sunflower over a disk that reaches the corners is clipped to
// that region (drop points inside the perimeter or past the usable square), giving
// a uniform fill that scales: the node radius auto-shrinks as the count climbs, so
// a LOT of external people stay packed and on-canvas instead of overflowing.
function externalLayout(total) {
  if (total <= 0) return { nodes: [], r: 9 };
  const half = CENTER - EDGE_PAD;
  const cornerDist = Math.hypot(half, half);
  const rMin = VILLAGE_OUTER + EXTERNAL_GAP;
  const diskArea = Math.PI * cornerDist * cornerDist;
  const regionArea = Math.max(1, 4 * half * half - Math.PI * rMin * rMin);
  const keepRatio = clamp(regionArea / diskArea, 0.05, 1);
  const M = Math.ceil(total / keepRatio) + 24; // disk-point budget sized to yield `total` kept
  const nodes = [];
  for (let i = 0; i < M && nodes.length < total; i += 1) {
    const radius = cornerDist * Math.sqrt((i + 0.5) / M);
    if (radius < rMin) continue; // inside the tribe — skip
    const angle = i * GOLDEN_ANGLE;
    const x = CENTER + Math.cos(angle) * radius;
    const y = CENTER + Math.sin(angle) * radius;
    if (x < EDGE_PAD || x > VIEW - EDGE_PAD || y < EDGE_PAD || y > VIEW - EDGE_PAD) continue; // past the canvas
    nodes.push({ x, y });
  }
  // Uniform-density node size from the disk packing, clamped to a legible range.
  const r = clamp(0.42 * Math.sqrt(diskArea / M), 3, 9);
  return { nodes, r };
}

export default function TribeCircleMap({ contacts, selectedId, onSelect, onLogTouch }) {
  // `hovered` drives the transient tooltip/enlarge and clears on mouse-leave.
  // `activeId` is sticky — it survives mouse-leave so the aside "Log touchpoint"
  // button stays mounted while the pointer travels from the node to the button
  // (otherwise leaving the node would unmount the button before the click lands).
  const [hovered, setHovered] = useState(null);
  const [activeId, setActiveId] = useState(null);

  // Split contacts: Dunbar rings get banded placement; external people get the
  // open outer region. Incoming order is preserved for stable positions.
  const placed = useMemo(() => {
    const dunbarIdx = Object.fromEntries(DUNBAR.map((ring, i) => [ring.id, i]));
    const dunbarGroups = DUNBAR.map(() => []);
    const external = [];
    for (const contact of contacts) {
      if (contact.ring === 'external') external.push(contact);
      else dunbarGroups[dunbarIdx[contact.ring] ?? dunbarIdx.tribe].push(contact);
    }
    const nodes = [];
    dunbarGroups.forEach((group, ringIdx) => {
      group.forEach((contact, slot) => {
        nodes.push({ contact, ringIdx, r: nodeRadius(ringIdx), isExternal: false, ...nodePosition(ringIdx, slot, group.length) });
      });
    });
    const ext = externalLayout(external.length);
    external.forEach((contact, idx) => {
      const pos = ext.nodes[idx];
      if (pos) nodes.push({ contact, ringIdx: -1, r: ext.r, isExternal: true, ...pos });
    });
    return { nodes, externalR: ext.r, externalCount: external.length };
  }, [contacts]);

  // External glyphs only carry initials when the nodes are large enough to read.
  const showExternalText = placed.externalR >= 8;
  const hoveredNode = hovered ? placed.nodes.find((n) => n.contact.id === hovered) : null;
  // The sticky-active node drives the persistent "Log touchpoint" action; falls
  // back to null once its contact leaves the list (e.g. after a ring change).
  const activeNode = activeId ? placed.nodes.find((n) => n.contact.id === activeId) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,300px)]">
      <div className="relative min-w-0 rounded border border-port-border bg-port-card p-2">
        <svg
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          className="h-auto w-full select-none"
          role="img"
          aria-label="Concentric map of tribe relationships by ring"
        >
          {/* Subtle tinted band fills in each Dunbar ring's theme color, behind the
              dashed lines and nodes. Drawn as a thick stroke at the band's mid
              radius = a clean annulus (no overlap, so z-order among them is moot). */}
          {DUNBAR.map((ring, i) => {
            const outerEdge = RING_RADII[i];
            const innerEdge = i === 0 ? 0 : RING_RADII[i - 1];
            return (
              <circle
                key={`band-${ring.id}`}
                cx={CENTER}
                cy={CENTER}
                r={(outerEdge + innerEdge) / 2}
                fill="none"
                stroke={ring.hex}
                strokeOpacity="0.06"
                strokeWidth={outerEdge - innerEdge}
              />
            );
          })}

          {/* Ring boundary lines + labels, outermost first so inner rings paint on top.
              The village outer edge is the tribe perimeter (external people live beyond
              it), so it's drawn as a solid, brighter line instead of a faint dash. */}
          {DUNBAR.map((_, i) => DUNBAR.length - 1 - i).map((i) => {
            const ring = DUNBAR[i];
            const isTribeEdge = i === TRIBE_EDGE_INDEX;
            return (
              <g key={ring.id}>
                <circle
                  cx={CENTER}
                  cy={CENTER}
                  r={RING_RADII[i]}
                  fill="none"
                  stroke={ring.hex}
                  strokeOpacity={isTribeEdge ? 0.5 : 0.28}
                  strokeWidth={isTribeEdge ? 2 : 1.5}
                  strokeDasharray={isTribeEdge ? undefined : '2 6'}
                />
                <text
                  x={CENTER}
                  y={CENTER - RING_RADII[i] - 6}
                  textAnchor="middle"
                  fill={ring.hex}
                  fillOpacity="0.85"
                  fontSize="13"
                  fontWeight="600"
                  className="uppercase tracking-wider"
                  // Halo (card-bg stroke painted under the fill) keeps the label
                  // legible over any node that lands near it on a dense ring.
                  strokeWidth="3"
                  style={strokeStyle(HALO, { paintOrder: 'stroke' })}
                >
                  {ring.label}
                </text>
              </g>
            );
          })}

          {/* External zone label — the whole open region outside the perimeter. */}
          <text
            x={CENTER}
            y={EDGE_PAD + 14}
            textAnchor="middle"
            fillOpacity="0.8"
            fontSize="13"
            fontWeight="600"
            className="uppercase tracking-wider"
            strokeWidth="3"
            style={{ fill: MUTED_INK, stroke: HALO, paintOrder: 'stroke' }}
          >
            External
          </text>

          {/* Center "Me" hub. */}
          <circle cx={CENTER} cy={CENTER} r={HUB_R} fillOpacity="0.15" strokeOpacity="0.6" style={{ fill: ACCENT, stroke: ACCENT }} />
          <text x={CENTER} y={CENTER + 5} textAnchor="middle" fontSize="15" fontWeight="700" style={fillStyle(ACCENT)}>Me</text>

          {/* People nodes — Dunbar rings (banded) and external (open outer region). */}
          {placed.nodes.map(({ contact, ringIdx, isExternal, r: baseR, x, y }) => {
            const status = contactStatus(contact);
            const energy = energyFor(contact.energy);
            const isSelected = selectedId === contact.id;
            const isHovered = hovered === contact.id;
            const r = baseR + (isSelected || isHovered ? 3 : 0);
            const ringLabel = isExternal ? 'External' : DUNBAR[ringIdx].label;
            const showText = isExternal ? showExternalText : true;
            return (
              <g
                key={contact.id}
                transform={`translate(${x} ${y})`}
                className="cursor-pointer"
                onClick={() => onSelect?.(contact)}
                onMouseEnter={() => { setHovered(contact.id); setActiveId(contact.id); }}
                onMouseLeave={() => setHovered((cur) => (cur === contact.id ? null : cur))}
                onFocus={() => { setHovered(contact.id); setActiveId(contact.id); }}
                onBlur={() => setHovered((cur) => (cur === contact.id ? null : cur))}
                {...clickableProps(() => onSelect?.(contact))}
                aria-label={`${contact.name || 'Unnamed'} — ${ringLabel}, ${status.label}`}
              >
                {isSelected && (
                  <circle r={r + 5} fill="none" stroke="#3b82f6" strokeWidth="2" strokeOpacity="0.9" />
                )}
                <circle
                  r={r}
                  fill={energy.hex}
                  fillOpacity="0.22"
                  stroke={STATUS_HEX[status.state] || STATUS_HEX.missing}
                  strokeWidth={status.state === 'overdue' || status.state === 'missing' ? 2.5 : 2}
                />
                {showText && (
                  <text
                    textAnchor="middle"
                    dy="0.35em"
                    style={fillStyle(NODE_INK)}
                    fontSize={isExternal ? 8 : (ringIdx < 2 ? 11 : 9)}
                    fontWeight="600"
                    pointerEvents="none"
                  >
                    {initialsFor(contact.name)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Hover tooltip — absolutely positioned card driven by the hovered node. */}
        {hoveredNode && (
          <div
            className="pointer-events-none absolute z-10 max-w-[220px] rounded border border-port-border bg-port-bg/95 px-3 py-2 text-xs shadow-lg"
            style={{
              left: `${(hoveredNode.x / VIEW) * 100}%`,
              top: `${(hoveredNode.y / VIEW) * 100}%`,
              transform: 'translate(-50%, calc(-100% - 14px))',
            }}
          >
            <p className="font-semibold text-port-text">{hoveredNode.contact.name || 'Unnamed person'}</p>
            {hoveredNode.contact.relationship && (
              <p className="mt-0.5 text-port-text-muted">{hoveredNode.contact.relationship}</p>
            )}
            <p className={`mt-1 ${contactStatus(hoveredNode.contact).tone}`}>
              {contactStatus(hoveredNode.contact).label}
            </p>
          </div>
        )}
      </div>

      {/* Legend + at-a-glance ring counts. */}
      <aside className="grid content-start gap-4">
        <div className="rounded border border-port-border bg-port-card p-4">
          <h3 className="text-sm font-semibold text-port-text">Rings</h3>
          <p className="mt-1 text-xs text-port-text-muted">Closer rings need more frequent care.</p>
          <div className="mt-3 grid gap-2">
            {RINGS.map((ring) => {
              const count = contacts.filter((c) => c.ring === ring.id).length;
              return (
                <div key={ring.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ring.hex }} aria-hidden="true" />
                    <span className={ring.tone}>{ring.label}</span>
                  </span>
                  <span className="text-port-text-muted">{ring.cap == null ? count : `${count} / ${ring.cap}`}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded border border-port-border bg-port-card p-4">
          <h3 className="text-sm font-semibold text-port-text">Node fill — energy</h3>
          <div className="mt-3 grid gap-2">
            {ENERGY.map((energy) => (
              <div key={energy.id} className="flex items-center gap-2 text-xs text-port-text-muted">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: energy.hex }} aria-hidden="true" />
                {energy.label}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded border border-port-border bg-port-card p-4">
          <h3 className="text-sm font-semibold text-port-text">Node outline — cadence</h3>
          <div className="mt-3 grid gap-2">
            {[
              { state: 'overdue', label: 'Overdue' },
              { state: 'soon', label: 'Due soon' },
              { state: 'steady', label: 'On track' },
              { state: 'missing', label: 'No touchpoint' },
            ].map((row) => (
              <div key={row.state} className="flex items-center gap-2 text-xs text-port-text-muted">
                <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: STATUS_HEX[row.state] }} aria-hidden="true" />
                {row.label}
              </div>
            ))}
          </div>
        </div>

        {activeNode && onLogTouch && (
          <button
            type="button"
            onClick={() => onLogTouch(activeNode.contact.id)}
            className="rounded border border-port-border px-3 py-2 text-xs text-port-accent hover:bg-port-accent/10"
          >
            Log touchpoint for {activeNode.contact.name || 'this person'}
          </button>
        )}
      </aside>
    </div>
  );
}
