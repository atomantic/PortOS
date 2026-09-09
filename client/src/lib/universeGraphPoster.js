/**
 * Print-ready infographic posters drawn from an indexed universe graph.
 *
 * Pure canvas drawing over the same `indexGraph` result the Graph tab already
 * holds — no fetching, no React. `renderPoster` is called both for the on-screen
 * preview (scale 1) and the 2× download, so the two can never diverge.
 */

import {
  edgeDef, evolutionStageRows, hexToRgba, kindDef, nodeInitials,
} from './universeGraphModel.js';

export const POSTER_LAYOUTS = Object.freeze([
  { id: 'roster', label: 'Cast roster', desc: 'Portrait grid of every character' },
  { id: 'dossier', label: 'Character dossier', desc: 'One character: framework, links, lens' },
  { id: 'atlas', label: 'Place atlas', desc: 'Locations and who moves through them' },
  { id: 'timeline', label: 'Timeline strip', desc: 'Presence across series and issues' },
  { id: 'web', label: 'Relationship web', desc: 'Typed links between the whole cast' },
]);

export const POSTER_SIZES = Object.freeze([
  { id: 'portrait', label: 'Portrait', dims: [1200, 1800] },
  { id: 'square', label: 'Square', dims: [1500, 1500] },
  { id: 'landscape', label: 'Landscape', dims: [1800, 1200] },
]);

export const POSTER_THEMES = Object.freeze([
  { id: 'midnight', label: 'Midnight' },
  { id: 'paper', label: 'Paper' },
]);

const PALETTES = {
  midnight: { bg: '#0f0f0f', card: '#1e1e1e', border: '#2a2a2a', ink: '#ffffff', muted: '#9ca3af', faint: '#6b7280' },
  paper: { bg: '#f5f1e8', card: '#ffffff', border: '#d4d4d8', ink: '#1a1a1a', muted: '#52525b', faint: '#71717a' },
};
const ACCENT = '#2563eb';
const WARN = '#f59e0b';
const FONT = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';

export const posterDimensions = (sizeId) =>
  (POSTER_SIZES.find((s) => s.id === sizeId) || POSTER_SIZES[0]).dims;

const byDegreeDesc = (index) => (a, b) => (index.degree.get(b.id) || 0) - (index.degree.get(a.id) || 0);

// Nodes visible at the poster's "as of" issue. `null` means the whole universe.
const visibleNodes = (index, asOfIssue) => (
  asOfIssue == null ? index.nodes : index.nodes.filter((n) => (n.firstIssue || 0) <= asOfIssue)
);

const issueLabel = (index, i) => {
  const issue = index.issues[i];
  return issue ? issue.name : '—';
};

/**
 * Draw one poster onto `canvas`.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {ReturnType<import('./universeGraphModel.js').indexGraph>} options.index
 * @param {string} options.layout   one of POSTER_LAYOUTS ids
 * @param {string} [options.subjectId] node id for the `dossier` layout
 * @param {string} [options.size]   one of POSTER_SIZES ids
 * @param {string} [options.theme]  one of POSTER_THEMES ids
 * @param {number|null} [options.asOfIssue] issue index the poster is scoped to
 * @param {number} [options.scale]  1 for preview, 2 for the print download
 */
export function renderPoster(canvas, {
  index, layout = 'roster', subjectId = null, size = 'portrait',
  theme = 'midnight', asOfIssue = null, scale = 1,
} = {}) {
  const [W, H] = posterDimensions(size);
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const dark = theme !== 'paper';
  const P = PALETTES[dark ? 'midnight' : 'paper'];
  const nodes = visibleNodes(index, asOfIssue);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = index.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const characters = nodes.filter((n) => n.kind === 'character').sort(byDegreeDesc(index));

  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);
  if (dark) {
    const glow = ctx.createRadialGradient(W / 2, -H * 0.1, 10, W / 2, 0, H * 0.9);
    glow.addColorStop(0, 'rgba(37,99,235,0.14)');
    glow.addColorStop(1, 'rgba(37,99,235,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  const wrap = (value, x, y, maxW, lineH, font, color, maxLines = 99) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const words = String(value ?? '').split(' ');
    let line = '';
    let ly = y;
    let used = 0;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxW && line) {
        if (used === maxLines - 1) {
          ctx.fillText(`${line.replace(/\s+\S*$/, '')}…`, x, ly);
          return ly + lineH;
        }
        ctx.fillText(line, x, ly);
        ly += lineH;
        line = word;
        used++;
      } else line = next;
    }
    if (line) { ctx.fillText(line, x, ly); ly += lineH; }
    return ly;
  };

  const avatar = (node, cx, cy, r) => {
    const color = kindDef(node.kind).color;
    if (node.hasImage) {
      const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      g.addColorStop(0, hexToRgba(color, 0.95));
      g.addColorStop(1, hexToRgba(color, 0.45));
      ctx.fillStyle = g;
    } else ctx.fillStyle = hexToRgba(color, dark ? 0.22 : 0.16);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.07);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = node.hasImage ? '#fff' : color;
    ctx.font = `600 ${r * 0.8}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(nodeInitials(node.name), cx, cy + r * 0.04);
  };

  const header = (title, sub) => {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = ACCENT;
    ctx.font = `600 ${W * 0.014}px ${FONT}`;
    ctx.fillText(String(index.name || 'Universe').toUpperCase(), 72, 64);
    ctx.fillStyle = P.ink;
    ctx.font = `700 ${W * 0.048}px ${FONT}`;
    ctx.fillText(title, 68, 64 + W * 0.02);
    ctx.fillStyle = P.muted;
    ctx.font = `${W * 0.016}px ${FONT}`;
    ctx.fillText(sub, 72, 64 + W * 0.082);
    ctx.fillStyle = P.border;
    ctx.fillRect(72, 64 + W * 0.116, W - 144, 2);
    return 64 + W * 0.116 + 40;
  };

  const footer = () => {
    ctx.fillStyle = P.faint;
    ctx.font = `${W * 0.011}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const scope = asOfIssue == null ? 'Whole universe' : `As of ${issueLabel(index, asOfIssue)}`;
    ctx.fillText(`${scope} · ${nodes.length} entries · ${edges.length} links · PortOS Universe Builder`, 72, H - 52);
    ctx.textAlign = 'right';
    ctx.fillText(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), W - 72, H - 52);
  };

  const relationshipLegend = (y) => {
    let x = 72;
    ctx.font = `${W * 0.011}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const type of ['ally', 'antagonist', 'rival', 'mentor', 'love-interest', 'family']) {
      const def = edgeDef(type);
      ctx.fillStyle = def.color;
      ctx.fillRect(x, y - 1.5, 22, 3);
      ctx.fillStyle = P.muted;
      ctx.fillText(def.label, x + 30, y);
      x += 30 + ctx.measureText(def.label).width + 26;
    }
  };

  // Typed relationship edges touching a node, both directions.
  const relationsOf = (node) => (index.adjacency.get(node.id) || [])
    .filter((e) => e.directed && ids.has(e.source) && ids.has(e.target));

  // Which characters share an issue with this place — the same signal the
  // "no cast" gap uses, since places carry no structured cast link.
  const castOfPlace = (place) => {
    const own = new Set(index.appear[place.id] || []);
    if (!own.size) return [];
    return characters.filter((c) => (index.appear[c.id] || []).some((i) => own.has(i)));
  };

  if (layout === 'roster') {
    const y = header('Cast roster', `${characters.length} characters · ordered by connection · ring marks a rendered reference`);
    const cols = W > H ? 6 : 4;
    const gap = 24;
    const cw = (W - 144 - gap * (cols - 1)) / cols;
    const rows = Math.max(1, Math.ceil(characters.length / cols));
    const ch = Math.min(cw * 1.05, Math.max(80, (H - y - 120 - gap * (rows - 1)) / rows));
    characters.forEach((node, i) => {
      const cx = 72 + (i % cols) * (cw + gap);
      const cy = y + Math.floor(i / cols) * (ch + gap);
      ctx.fillStyle = P.card;
      ctx.strokeStyle = node.locked ? hexToRgba(ACCENT, 0.5) : P.border;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(cx, cy, cw, ch, 8);
      ctx.fill();
      ctx.stroke();
      const r = Math.min(cw * 0.22, ch * 0.22);
      avatar(node, cx + cw / 2, cy + r + ch * 0.1, r);
      ctx.font = `600 ${Math.min(22, cw * 0.085)}px ${FONT}`;
      ctx.fillStyle = P.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.name, cx + cw / 2, cy + r * 2 + ch * 0.16);
      wrap(node.role, cx + 14, cy + r * 2 + ch * 0.16 + Math.min(22, cw * 0.085) * 1.4,
        cw - 28, Math.min(18, cw * 0.07) * 1.3, `${Math.min(18, cw * 0.07)}px ${FONT}`, P.muted, 2);
      const rels = relationsOf(node).slice(0, 12);
      let lx = cx + cw / 2 - rels.length * 5;
      for (const edge of rels) {
        ctx.fillStyle = edgeDef(edge.type).color;
        ctx.beginPath();
        ctx.arc(lx + 5, cy + ch - 22, 4, 0, Math.PI * 2);
        ctx.fill();
        lx += 10;
      }
    });
    relationshipLegend(H - 90);
    footer();
  } else if (layout === 'dossier') {
    const node = index.byId.get(subjectId) || characters[0];
    if (!node) { footer(); return; }
    const y = header(node.name, node.role);
    const colW = (W - 144 - 48) / 2;
    avatar(node, 72 + colW * 0.28, y + colW * 0.28, colW * 0.26);
    let ty = y + colW * 0.6;
    const sliders = node.sliders || {};
    for (const axis of ['proactivity', 'likability', 'competence']) {
      ctx.font = `${W * 0.013}px ${FONT}`;
      ctx.fillStyle = P.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(axis[0].toUpperCase() + axis.slice(1), 72, ty);
      ctx.fillStyle = P.border;
      ctx.fillRect(72 + colW * 0.3, ty - 4, colW * 0.6, 8);
      const value = Number.isInteger(sliders[axis]) ? sliders[axis] : null;
      if (value != null) {
        ctx.fillStyle = kindDef('character').color;
        ctx.fillRect(72 + colW * 0.3, ty - 4, colW * 0.6 * (value / 10), 8);
      }
      ctx.fillStyle = value == null ? P.faint : P.ink;
      ctx.textAlign = 'right';
      ctx.fillText(value == null ? '—' : String(value), 72 + colW, ty);
      ty += W * 0.03;
    }
    ty += 20;
    ctx.textAlign = 'left';
    const framework = node.framework || {};
    for (const field of ['ghost', 'wound', 'lie', 'need', 'want']) {
      ctx.font = `600 ${W * 0.011}px ${FONT}`;
      ctx.fillStyle = ACCENT;
      ctx.textBaseline = 'top';
      ctx.fillText(field.toUpperCase(), 72, ty);
      ty = wrap(framework[field] || 'Not authored', 72, ty + W * 0.016, colW, W * 0.02,
        `${W * 0.015}px ${FONT}`, framework[field] ? P.ink : P.faint) + 14;
    }
    const rx = 72 + colW + 48;
    let ry = y;
    const section = (title) => {
      ctx.fillStyle = ACCENT;
      ctx.font = `600 ${W * 0.011}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(title, rx, ry);
      ry += W * 0.024;
    };
    section('RELATIONSHIPS');
    const rels = relationsOf(node).slice(0, 12);
    for (const edge of rels) {
      const other = edge.source === node.id ? edge.targetNode : edge.sourceNode;
      const def = edgeDef(edge.type);
      ctx.fillStyle = def.color;
      ctx.beginPath();
      ctx.arc(rx + 8, ry + W * 0.009, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = P.ink;
      ctx.font = `${W * 0.014}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(other.name, rx + 26, ry);
      ctx.fillStyle = def.color;
      ctx.font = `${W * 0.011}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(`${edge.source === node.id ? '→' : '←'} ${def.label}`, W - 72, ry + 3);
      ry += W * 0.024;
    }
    if (!rels.length) {
      ctx.fillStyle = P.faint;
      ctx.font = `${W * 0.013}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText('No typed relationships authored.', rx, ry);
      ry += W * 0.03;
    }
    ry += 24;
    section(`EVOLUTION LENS${node.evolution?.outcome ? ` · ${node.evolution.outcome}` : ''}`);
    const stepW = colW / 5;
    evolutionStageRows(node.evolution).forEach((row, i) => {
      const sx = rx + i * stepW;
      ctx.fillStyle = P.border;
      ctx.fillRect(sx, ry + 10, stepW, 2);
      ctx.fillStyle = row.authored ? '#a855f7' : P.bg;
      ctx.strokeStyle = '#a855f7';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx + 8, ry + 11, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      wrap(row.label, sx, ry + 30, stepW - 10, W * 0.014, `${W * 0.0105}px ${FONT}`,
        row.authored ? P.muted : P.faint, 3);
    });
    ry += W * 0.09;
    ry += 24;
    section('APPEARS IN');
    const seen = new Map();
    for (const i of index.appear[node.id] || []) {
      const issue = index.issues[i];
      if (!issue) continue;
      seen.set(issue.seriesId, (seen.get(issue.seriesId) || 0) + 1);
    }
    for (const [seriesId, count] of seen) {
      const series = index.byId.get(seriesId);
      ctx.fillStyle = P.ink;
      ctx.font = `${W * 0.014}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(series ? series.name : seriesId, rx, ry);
      ctx.fillStyle = P.faint;
      ctx.textAlign = 'right';
      ctx.fillText(`${count} issue${count === 1 ? '' : 's'}`, W - 72, ry + 2);
      ry += W * 0.022;
    }
    if (!seen.size) {
      ctx.fillStyle = P.faint;
      ctx.font = `${W * 0.013}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText('Not yet used in any series.', rx, ry);
      ry += W * 0.03;
    }
    ry += 24;
    section('PLACES & OBJECTS');
    for (const edge of index.adjacency.get(node.id) || []) {
      if (edge.type !== 'attachment' || !ids.has(edge.source) || !ids.has(edge.target)) continue;
      const other = edge.source === node.id ? edge.targetNode : edge.sourceNode;
      ctx.fillStyle = kindDef(other.kind).color;
      ctx.fillRect(rx, ry + 4, 8, 8);
      ctx.fillStyle = P.ink;
      ctx.font = `${W * 0.014}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(other.name, rx + 20, ry);
      ctx.fillStyle = P.faint;
      ctx.textAlign = 'right';
      ctx.fillText(edge.label || '', W - 72, ry + 2);
      ry += W * 0.022;
    }
    footer();
  } else if (layout === 'atlas') {
    const places = nodes.filter((n) => n.kind === 'place');
    const y = header('Place atlas', `${places.length} locations and who moves through them`);
    const cols = W > H ? 4 : 3;
    const gap = 22;
    const cw = (W - 144 - gap * (cols - 1)) / cols;
    const rows = Math.max(1, Math.ceil(places.length / cols));
    const ch = Math.min(cw * 0.95, Math.max(80, (H - y - 100 - gap * (rows - 1)) / rows));
    places.forEach((place, i) => {
      const cx = 72 + (i % cols) * (cw + gap);
      const cy = y + Math.floor(i / cols) * (ch + gap);
      ctx.fillStyle = P.card;
      ctx.strokeStyle = P.border;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(cx, cy, cw, ch, 8);
      ctx.fill();
      ctx.stroke();
      const band = ctx.createLinearGradient(cx, cy, cx, cy + ch * 0.42);
      band.addColorStop(0, hexToRgba(kindDef('place').color, place.hasImage ? 0.55 : 0.12));
      band.addColorStop(1, hexToRgba(kindDef('place').color, place.hasImage ? 0.2 : 0.04));
      ctx.fillStyle = band;
      ctx.beginPath();
      ctx.roundRect(cx + 1, cy + 1, cw - 2, ch * 0.42, [7, 7, 0, 0]);
      ctx.fill();
      if (!place.hasImage) {
        ctx.fillStyle = hexToRgba(kindDef('place').color, 0.6);
        ctx.font = `${W * 0.01}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('no render yet', cx + cw / 2, cy + ch * 0.21);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = P.ink;
      ctx.font = `600 ${Math.min(24, cw * 0.075)}px ${FONT}`;
      ctx.fillText(place.name, cx + 16, cy + ch * 0.46);
      ctx.fillStyle = P.muted;
      ctx.font = `${Math.min(17, cw * 0.055)}px ${FONT}`;
      ctx.fillText(place.role, cx + 16, cy + ch * 0.46 + Math.min(24, cw * 0.075) * 1.4);
      const cast = castOfPlace(place);
      const ar = Math.min(16, cw * 0.05);
      let ax = cx + 16;
      for (const member of cast.slice(0, 7)) { avatar(member, ax + ar, cy + ch - ar - 16, ar); ax += ar * 2.3; }
      if (!cast.length) {
        ctx.fillStyle = WARN;
        ctx.font = `${Math.min(15, cw * 0.05)}px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText('⚠ no cast in its issues', cx + 16, cy + ch - 16);
      }
    });
    footer();
  } else if (layout === 'timeline') {
    const top = characters.slice(0, W > H ? 14 : 18);
    const T = Math.max(1, index.totalIssues);
    let y = header('Timeline strip', `Presence of ${top.length} characters across ${index.series.length} series`);
    const lx = 72 + W * 0.17;
    const gw = W - 72 - lx;
    const rowH = Math.min(58, Math.max(20, (H - y - 130) / Math.max(1, top.length)));
    const colW = gw / T;
    index.series.forEach((series, i) => {
      const issues = index.issues.filter((x) => x.seriesId === series.id);
      if (!issues.length) return;
      const x0 = lx + issues[0].index * colW;
      ctx.fillStyle = hexToRgba(kindDef('series').color, 0.05 + (i % 2) * 0.05);
      ctx.fillRect(x0, y, issues.length * colW, top.length * rowH + 30);
      ctx.fillStyle = kindDef('series').color;
      ctx.font = `600 ${W * 0.011}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(series.name, x0 + 8, y + 6);
    });
    y += 30;
    top.forEach((node, i) => {
      const ry = y + i * rowH + rowH / 2;
      avatar(node, 72 + rowH * 0.3, ry, rowH * 0.3);
      ctx.fillStyle = P.ink;
      ctx.font = `${Math.min(18, rowH * 0.34)}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.name, 72 + rowH * 0.75, ry);
      ctx.fillStyle = P.border;
      ctx.fillRect(lx, ry, gw, 1);
      const seen = (index.appear[node.id] || []).filter((x) => asOfIssue == null || x <= asOfIssue);
      if (seen.length > 1) {
        ctx.strokeStyle = hexToRgba(kindDef('character').color, 0.5);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(lx + seen[0] * colW + colW / 2, ry);
        ctx.lineTo(lx + seen[seen.length - 1] * colW + colW / 2, ry);
        ctx.stroke();
      }
      for (const x of seen) {
        ctx.fillStyle = kindDef('character').color;
        ctx.beginPath();
        ctx.arc(lx + x * colW + colW / 2, ry, Math.max(2, rowH * 0.13), 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `${W * 0.01}px ${FONT}`;
    ctx.fillStyle = kindDef('character').color;
    ctx.beginPath();
    ctx.arc(77, H - 92, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = P.muted;
    ctx.fillText('appears in issue', 88, H - 92);
    footer();
  } else if (layout === 'web') {
    const cast = characters.slice(0, 28);
    const y = header('Relationship web', `${cast.length} characters · every typed link between them`);
    const castIds = new Set(cast.map((n) => n.id));
    const cx = W / 2;
    const cy = y + (H - y - 140) / 2;
    const R = Math.min(W, H - y - 140) * 0.38;
    const at = new Map(cast.map((node, i) => {
      const a = (i / Math.max(1, cast.length)) * Math.PI * 2 - Math.PI / 2;
      return [node.id, [cx + Math.cos(a) * R, cy + Math.sin(a) * R, a]];
    }));
    ctx.lineCap = 'round';
    for (const edge of edges) {
      if (!edge.directed || !castIds.has(edge.source) || !castIds.has(edge.target)) continue;
      const [ax, ay] = at.get(edge.source);
      const [bx, by] = at.get(edge.target);
      ctx.strokeStyle = hexToRgba(edgeDef(edge.type).color, 0.6);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      // Bow every chord toward the centre so parallel links stay separable.
      ctx.quadraticCurveTo(cx + (ax + bx - 2 * cx) * 0.22, cy + (ay + by - 2 * cy) * 0.22, bx, by);
      ctx.stroke();
    }
    const ar = Math.max(14, Math.min(34, R * 0.13));
    for (const node of cast) {
      const [ax, ay, angle] = at.get(node.id);
      avatar(node, ax, ay, ar);
      ctx.save();
      ctx.translate(ax + Math.cos(angle) * (ar + 10), ay + Math.sin(angle) * (ar + 10));
      ctx.rotate(Math.abs(angle) > Math.PI / 2 ? angle + Math.PI : angle);
      ctx.fillStyle = P.ink;
      ctx.font = `${W * 0.011}px ${FONT}`;
      ctx.textAlign = Math.abs(angle) > Math.PI / 2 ? 'right' : 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.name, 0, 0);
      ctx.restore();
    }
    relationshipLegend(H - 90);
    footer();
  }
}
