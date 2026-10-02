/**
 * Music Video — the Cast & Sets check-in sheet (pure HTML generator).
 *
 * One self-contained page the director reviews before the storyboard: the
 * logline, the protagonist's facts beside the canonical character sheet, the
 * looks, the expression sheet, the in-set tests, every set plate with the song
 * sections it serves, a song-map bar colored by set, the overlay concept and
 * the questions that need an answer.
 *
 * Self-contained means no network: every image arrives as a `data:` URI from
 * the caller, the type uses system font stacks (no web fonts), and there is no
 * script. The PortOS viewer serves it into a sandboxed iframe under a CSP that
 * would block any external fetch anyway; the sheet is also meant to be saved
 * and opened on its own.
 */

import { plannedTests } from './castAndSetsPlan.js';
import { renderDefinitionsSection } from './castAndSetsDefinitions.js';

// One color per set (song-map bar + dots), in set order.
export const CAST_SETS_SET_COLORS = Object.freeze(['#b8d63a', '#2fae8f', '#8a5cff', '#e0342b', '#18c7d6', '#3d7bff', '#f0a13a', '#ff5a1f']);
const NEUTRAL = '#3b4a44';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const e = escapeHtml;

const fmtTime = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

// Only `data:image/*` sources are embedded; anything else renders as a
// placeholder so the file can never reach the network.
const safeSrc = (src) => (typeof src === 'string' && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null);

function figure(src, alt, caption, cls = '', placeholder = 'Image not rendered') {
  const ok = safeSrc(src);
  const media = ok
    ? `<img src="${ok}" alt="${e(alt)}">`
    : `<div class="missing" role="img" aria-label="${e(alt)}">${e(placeholder)}</div>`;
  return `<figure${cls ? ` class="${cls}"` : ''}>${media}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

const STYLE = `
:root{--bg:#0b0f0d;--panel:#131a17;--line:#26312c;--fg:#e7ece9;--muted:#9aa8a1;--accent:#ff5a1f;--green:#b8d63a;
--display:"Impact","Haettenschweiler","Arial Narrow Bold","Arial Narrow",sans-serif;
--body:"Helvetica Neue","Arial Narrow",Arial,sans-serif;--mono:ui-monospace,Menlo,Consolas,monospace;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--body);font-size:16px;line-height:1.55}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}
.hud{display:flex;flex-wrap:wrap;gap:8px 20px;font-family:var(--mono);font-size:12px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase;border-bottom:1px solid var(--line);padding-bottom:10px}
.hud b{color:var(--accent);font-weight:500}
h1{font-family:var(--display);font-weight:900;font-size:clamp(48px,10vw,120px);line-height:.9;margin:28px 0 10px;letter-spacing:.01em;overflow-wrap:anywhere}
h2{font-family:var(--display);font-weight:700;font-size:clamp(28px,4.4vw,44px);line-height:1;margin:56px 0 6px;letter-spacing:.02em}
h2 small{display:block;font-family:var(--mono);font-size:12px;letter-spacing:.12em;color:var(--accent);margin-bottom:10px;text-transform:uppercase}
.lede{font-size:clamp(18px,2.2vw,22px);max-width:62ch;margin:0}
.sub{color:var(--muted);max-width:68ch}
.grid2{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;margin-top:22px}
.grid2>*,.row>*,.sets>*,.overlay>*{min-width:0}
figure{margin:0}
figure img,.missing{display:block;width:100%;height:auto;border:1px solid var(--line)}
.missing{aspect-ratio:3/2;display:flex;align-items:center;justify-content:center;color:var(--muted);font-family:var(--mono);font-size:12px;background:var(--panel)}
figcaption{font-family:var(--mono);font-size:12px;color:var(--muted);padding-top:8px}
.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:15px;margin:0}
.facts dt{font-family:var(--mono);font-size:12px;color:var(--accent);text-transform:uppercase;letter-spacing:.08em;padding-top:3px}
.facts dd{margin:0}
.wide{margin-top:18px}
.row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}
.sets{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:20px}
.set figcaption{display:grid;gap:2px}
.set figcaption b{font-family:var(--body);font-size:17px;color:var(--fg);font-weight:600}
.set figcaption span{font-family:var(--body);font-size:14px;color:var(--muted)}
.set figcaption em{font-style:normal;color:var(--green);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.def{border:1px solid var(--line);background:var(--panel);padding:16px;margin-top:18px}
.def h3{font-family:var(--display);font-size:24px;margin:0 0 10px;font-weight:700}
.def h3 span{font-family:var(--mono);font-size:12px;color:var(--muted);letter-spacing:.08em;margin-left:8px}
.def-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.def-tile svg{display:block;width:100%;height:auto;background:#0b0f0d;border:1px solid var(--line)}
.swatches{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.swatch i{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-2px;border:1px solid var(--line)}
.bar{display:flex;height:44px;border:1px solid var(--line);margin-top:20px;overflow:hidden}
.seg{position:relative;border-right:1px solid var(--bg);min-width:0}
.seg span{position:absolute;left:4px;bottom:3px;font-family:var(--mono);font-size:10px;color:#0b0f0d;white-space:nowrap;overflow:hidden;max-width:calc(100% - 6px)}
.ticks{display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:4px}
.tablewrap{overflow-x:auto;margin-top:16px}
table{border-collapse:collapse;width:100%;min-width:560px;font-size:14px}
td{border-top:1px solid var(--line);padding:9px 10px 9px 0;vertical-align:top}
td.tc{font-family:var(--mono);color:var(--muted);white-space:nowrap;width:64px}
.dot{display:inline-block;width:9px;height:9px;margin-right:8px;vertical-align:1px}
.overlay{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px}
.overlay>div{border:1px solid var(--line);background:var(--panel);padding:14px 16px}
.overlay h3{font-family:var(--mono);font-size:12px;letter-spacing:.1em;color:var(--accent);text-transform:uppercase;margin:0 0 6px;font-weight:500}
.overlay p{margin:0;font-size:14.5px}
.ask{border:1px solid var(--accent);padding:18px 20px;margin-top:22px;background:var(--panel)}
.ask ol{margin:8px 0 0;padding-left:20px}
.ask li{margin:6px 0}
@media (max-width:760px){.grid2,.sets,.overlay{grid-template-columns:1fr}.row{grid-template-columns:repeat(2,1fr)}}
`;

const PROCEDURAL_QUESTIONS = [
  'Is the character construction right: shapes, materials, palette and expressions?',
  'Do the movement, camera and transition rules fit the song?',
  'Do the environments and their image roles work, or should any be swapped out?',
];
const DEFAULT_QUESTIONS = [
  'Is the protagonist right: face, hair, signature detail and the looks?',
  'Do the sets work, or should any be swapped out?',
  'Is the overlay concept right for the on-screen text?',
];

/**
 * Render the sheet. `images` maps plan keys to `data:` URIs (missing = a
 * placeholder). `sections` are the analyzed song sections (songSections()).
 * Returns the HTML document string.
 */
export function renderCastAndSetsSheet({
  title = 'Music Video', project = null, direction, images = {}, sections = [], durationSec = null, bpm = null,
  revision = 1, notesApplied = [], checkinMode = 'review', status = 'review',
}) {
  const d = direction || {};
  const procedural = d.medium === 'procedural';
  const p = d.protagonist || {};
  const w = d.world || {};
  const sets = d.sets || [];
  const colorOf = new Map(sets.map((s, i) => [s.id, CAST_SETS_SET_COLORS[i % CAST_SETS_SET_COLORS.length]]));
  const setOfSection = new Map((d.songMap || []).map((m) => [m.section, m.setId]));
  const tests = plannedTests(project, d);
  const total = durationSec || (sections.length ? sections[sections.length - 1].endSec : 0);

  const facts = (procedural ? [
    ['Who', p.description],
    ['Construction', p.construction],
    ['Shapes', p.shapeLanguage],
    ['Materials', p.materials],
    ['Palette', p.palette],
    ['Expressions', (p.expressions || []).join('; ')],
    ['Movement', p.movement],
    ['Signature', p.signature],
    ['Gesture', p.gesture],
    ['Rules', (p.rules || []).map((r) => r.replace(/[.;]\s*$/, '')).join('; ')],
  ] : [
    ['Who', p.description],
    ['Face', p.face],
    ['Hair', p.hair],
    ['Signature', p.signature],
    ['Gesture', p.gesture],
    ['Rules', (p.rules || []).map((r) => r.replace(/[.;]\s*$/, '')).join('; ')],
  ]).filter(([, v]) => v).map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('');

  const looksCaption = (d.looks || []).map((l, i) => `0${i + 1} ${e(l.name)}${l.chapters ? ` (${e(l.chapters)})` : ''}`).join(' · ');

  const testFigures = tests.map((t, i) => {
    const set = sets.find((s) => s.id === t.setId);
    return figure(images[`test:${i + 1}`], `${set?.name || 'Set'} test`, e(t.caption || t.action || set?.name || ''));
  }).join('');

  const setFigures = sets.map((s) => {
    const role = procedural ? `<em>Role: ${e(s.imageRole || 'background')}</em>` : '';
    const caption = `<b>${e(s.name)}</b><span>${e(s.description)}${s.lighting ? ` ${e(s.lighting)}` : ''}</span>${role}${(s.sections || []).length ? `<em>${e(s.sections.join(', '))}</em>` : ''}`;
    return figure(images[`set:${s.id}`], s.name, caption, 'set', procedural ? 'No raster image: drawn in code' : undefined);
  }).join('');

  const bar = sections.map((s) => {
    const setId = setOfSection.get(s.index);
    const color = colorOf.get(setId) || NEUTRAL;
    const setName = sets.find((x) => x.id === setId)?.name || 'Unassigned';
    return `<div class="seg" style="flex:${Math.max(0.01, s.endSec - s.startSec).toFixed(2)};background:${color}" title="${e(s.label)} ${fmtTime(s.startSec)}–${fmtTime(s.endSec)} · ${e(setName)}"><span>${e(s.label)}</span></div>`;
  }).join('');
  const rows = sections.map((s) => {
    const setId = setOfSection.get(s.index);
    const set = sets.find((x) => x.id === setId);
    return `<tr><td class="tc">${fmtTime(s.startSec)}</td><td><span class="dot" style="background:${colorOf.get(setId) || NEUTRAL}"></span>${e(s.label)}</td><td>${set ? e(set.name) : 'Unassigned'}</td></tr>`;
  }).join('');

  const overlay = d.overlayConcept || {};
  const overlayCards = (overlay.elements || []).map((el) => `<div><h3>${e(el.name)}</h3><p>${e(el.description)}</p></div>`).join('');
  const worldFacts = [['Layout', w.layout], ['Depth', w.depth], ['Lighting', w.lighting], ['Camera', w.camera], ['Transitions', w.transitions]]
    .filter(([, v]) => v).map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('');
  const questions = (d.questions && d.questions.length ? d.questions : (procedural ? PROCEDURAL_QUESTIONS : DEFAULT_QUESTIONS)).map((q) => `<li>${e(q)}</li>`).join('');
  const applied = notesApplied.length
    ? `<p class="sub"><b>Revision ${revision}.</b> Notes applied: ${notesApplied.map((n) => `${n.target ? `[${e(n.target)}] ` : ''}${e(n.text)}`).join(' · ')}</p>`
    : '';
  const statusLine = status === 'approved'
    ? '<p class="sub" style="margin:10px 0 0"><b>Approved.</b> These references now condition the storyboard frames.</p>'
    : `<p class="sub" style="margin:10px 0 0">${checkinMode === 'auto' ? 'Auto-approve is on: the autopilot continues to the storyboard.' : 'Add a note on any item in PortOS, then regenerate or approve to continue to the storyboard.'}</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)} — Cast &amp; Sets</title>
<style>${STYLE}</style></head>
<body><div class="wrap">
<div class="hud"><span>Check-in <b>Cast &amp; Sets</b></span><span>Revision <b>${Number(revision) || 1}</b></span>${p.name ? `<span>Protagonist <b>${e(p.name)}</b></span>` : ''}${total ? `<span>Track ${fmtTime(total)}${bpm ? ` · ${Math.round(bpm)} BPM` : ''}</span>` : ''}<span>${sets.length} sets · ${procedural ? 'built in code' : `${(d.looks || []).length} looks`}</span></div>
<h1>${e(title)}</h1>
<p class="lede">${e(d.logline)}</p>
${d.interpretation ? `<p class="sub">${e(d.interpretation)}</p>` : ''}
${applied}
<section><h2><small>Protagonist</small>${e(p.name || 'Protagonist')}</h2>
${procedural ? `<dl class="facts wide">${facts}</dl></section>
${renderDefinitionsSection(d.definitions)}
${worldFacts ? `<section><h2><small>World</small>How the environments behave</h2><dl class="facts wide">${worldFacts}</dl></section>` : ''}` : `<div class="grid2">${figure(images.character, 'Character reference sheet: front, three-quarter, profile, back and face', 'Canonical reference sheet. Every later image of the protagonist uses it as a reference.')}<div><dl class="facts">${facts}</dl></div></div>
${figure(images.looks, 'Wardrobe looks', looksCaption ? `Wardrobe by chapter: ${looksCaption}` : 'Wardrobe', 'wide')}
<div class="grid2">${figure(images.expressions, 'Expression sheet', `Expression range for lip-sync keyframes.${p.gesture ? ` Includes the gesture: ${e(p.gesture)}` : ''}`)}${tests[0] ? figure(images['test:1'], 'First in-set test', e(tests[0].caption || tests[0].action)) : ''}</div>
</section>
<section><h2><small>In-set tests</small>The protagonist, in the world</h2><div class="row">${testFigures}</div></section>`}
<section><h2><small>Sets</small>${sets.length} sets</h2><p class="sub">Each set has its own light, so a cut says where we are before anything else.</p><div class="sets">${setFigures}</div></section>
<section><h2><small>Song map</small>Where each set lives in the track</h2>
${sections.length ? `<div class="bar">${bar}</div><div class="ticks"><span>0:00</span><span>${fmtTime(total)}</span></div><div class="tablewrap"><table>${rows}</table></div>` : '<p class="sub">The song has not been sectioned yet.</p>'}
</section>
<section><h2><small>Overlay layer</small>What ties every shot together</h2>${overlay.summary ? `<p class="sub">${e(overlay.summary)}</p>` : ''}${overlayCards ? `<div class="overlay">${overlayCards}</div>` : ''}</section>
<div class="ask"><b>What I need from you before the storyboard</b><ol>${questions}</ol>${statusLine}</div>
</div></body></html>
`;
}
