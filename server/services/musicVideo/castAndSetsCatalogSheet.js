/**
 * Music Video — the visual guide for a catalog-linked Cast & Sets stage
 * (pure HTML generator, same self-contained rules as castAndSetsSheet.js).
 *
 * A catalog stage has no generated direction, so everything here comes from the
 * resolved check-in items and the project's own shots. Which set a shot belongs
 * to is the answer conditioning uses (`sceneCatalogSubjectIds`), so the song map
 * cannot disagree with what the shot would actually render from.
 */

import { isPreMusicShot } from '../../lib/musicVideoColdOpen.js';
import { activeMusicVideoSubjects } from '../../lib/musicVideoCastSelection.js';
import { sceneCatalogSubjectIds } from '../../lib/musicVideoConditioning.js';
import { musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';
import { pluralize as plural } from '../../lib/textUtils.js';
import { CAST_SETS_SET_COLORS, CAST_SETS_SHEET_STYLE, SHEET_NEUTRAL_COLOR as NEUTRAL, escapeHtml as e, formatSheetTime, sheetFigure } from './castAndSetsSheet.js';

// Each image is a data: URI in the page, so a subject shows its lead images and
// says how many more the catalog holds.
const IMAGES_PER_SUBJECT = 3;
// Consecutive shots of one set closer than this read as one span on the map.
const SPAN_JOIN_SEC = 0.05;

const CATALOG_STYLE = `
.subject{min-width:0}
.subject.off img{opacity:.55}
.extra{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:8px}
.set figcaption em.off{color:var(--muted)}
`;

/** The filenames the sheet embeds; the caller turns them into `data:` URIs. */
export const catalogSheetImageFiles = (items) => [...new Set((items || []).flatMap((item) => (item.images || []).slice(0, IMAGES_PER_SUBJECT)))];

/**
 * Every timed song shot's set, as contiguous spans plus a per-set summary.
 * `subjectId: null` is a shot no catalog place claims. Cold-open shots run before
 * the song on their own clock, so they are not on this map.
 */
function catalogSongMap(project, items) {
  const placeIds = new Set(items.filter((item) => item.kind === 'place').map((item) => item.subjectId));
  const resolved = { ...project, castAndSets: { ...project?.castAndSets, catalogCheckin: { items } } };
  const shots = (project?.scenes || [])
    .filter((scene) => Number.isFinite(scene?.startSec) && scene.endSec > scene.startSec && !isPreMusicShot(scene))
    .sort((a, b) => a.startSec - b.startSec)
    .map((scene) => ({ startSec: scene.startSec, endSec: scene.endSec,
      subjectId: sceneCatalogSubjectIds(resolved, scene).find((id) => placeIds.has(id)) || null }));
  const spans = [];
  for (const shot of shots) {
    const last = spans.at(-1);
    if (last?.subjectId === shot.subjectId && shot.startSec <= last.endSec + SPAN_JOIN_SEC) last.endSec = Math.max(last.endSec, shot.endSec);
    else spans.push({ ...shot });
  }
  const bySet = new Map();
  const entry = (subjectId) => {
    if (!bySet.has(subjectId)) bySet.set(subjectId, { shots: 0, seconds: 0, spans: [] });
    return bySet.get(subjectId);
  };
  for (const shot of shots) entry(shot.subjectId).shots += 1;
  for (const span of spans) {
    const summary = entry(span.subjectId);
    summary.seconds += span.endSec - span.startSec;
    summary.spans.push(span);
  }
  return { spans, bySet };
}

const spanList = (spans) => spans.map((span) => `${formatSheetTime(span.startSec)}–${formatSheetTime(span.endSec)}`).join(', ');

function subjectCard(item, { images, placeholder, mark = null }) {
  const shown = (item.images || []).slice(0, IMAGES_PER_SUBJECT);
  const name = `${item.name}${item.formLabel ? ` · ${item.formLabel}` : ''}`;
  const more = (item.images || []).length - shown.length;
  const caption = `<b>${e(name)}</b>${item.description ? `<span>${e(item.description)}</span>` : ''}${mark ? `<em${mark.off ? ' class="off"' : ''}>${e(mark.text)}</em>` : ''}${more > 0 ? `<span>${plural(more, 'more image')} in the catalog</span>` : ''}`;
  const extras = shown.slice(1).map((file, index) => sheetFigure(images[file], `${item.name} reference ${index + 2}`, '', '', placeholder)).join('');
  return `<div class="subject${mark?.dim ? ' off' : ''}">${sheetFigure(images[shown[0]], `${item.name} reference`, caption, 'set', placeholder)}${extras ? `<div class="extra">${extras}</div>` : ''}</div>`;
}

/**
 * Render the guide. `checkin` is `resolveCatalogCheckin`'s result, `images` maps
 * a filename to its `data:` URI (missing = a placeholder). The saved page states no
 * approval: approval follows the live catalog and this file would soon contradict it.
 */
export function renderCatalogCastAndSetsSheet({ title = 'Music Video', project = null, checkin, images = {}, durationSec = null, bpm = null, revision = 1 }) {
  const items = checkin?.items || [];
  const subjects = project?.concept?.subjects || [];
  const subjectOf = new Map(subjects.map((subject) => [subject.id, subject]));
  const active = activeMusicVideoSubjects(project?.concept);
  const sharedName = (item) => subjectOf.get(item.subjectId)?.name?.trim() || '';
  const placeholder = musicVideoAllowsMedia(project, 'image') ? 'Image not rendered' : 'No raster image: drawn in code';

  const characters = items.filter((item) => item.kind === 'character');
  const nameCounts = new Map();
  for (const item of characters) if (sharedName(item)) nameCounts.set(sharedName(item), (nameCounts.get(sharedName(item)) || 0) + 1);
  const isSelected = (item) => active.includes(subjectOf.get(item.subjectId));
  const alternateMark = (item) => {
    const selected = isSelected(item);
    if (selected && (nameCounts.get(sharedName(item)) || 0) < 2) return null;
    const of = sharedName(item) ? `Alternate for ${sharedName(item)}` : 'Alternate';
    return { text: `${of} · ${selected ? 'Selected' : 'Not selected'}`, off: !selected, dim: !selected };
  };
  const castGroup = (heading, list, unit, intro) => {
    if (!list.length) return '';
    const selected = list.filter(isSelected).length;
    const unselected = list.length - selected;
    const count = `${plural(selected, unit)}${unselected ? ` · ${plural(unselected, 'alternate')} not selected` : ''}`;
    return `<section><h2><small>${e(heading)}</small>${e(count)}</h2><p class="sub">${e(intro)}</p><div class="sets">${list.map((item) => subjectCard(item, { images, placeholder, mark: alternateMark(item) })).join('')}</div></section>`;
  };
  const roleOf = (item) => subjectOf.get(item.subjectId)?.role;
  const castSections = [
    castGroup('Protagonists', characters.filter((item) => roleOf(item) === 'protagonist'), 'protagonist', 'Each one is a lead of this video, shown from the catalog record it links to.'),
    castGroup('Band', characters.filter((item) => roleOf(item) === 'band'), 'band member', 'Shots that name them use these catalog images.'),
    castGroup('Supporting cast', characters.filter((item) => !['protagonist', 'band'].includes(roleOf(item))), 'character', 'Shots that name them use these catalog images.'),
  ].join('');

  const places = items.filter((item) => item.kind === 'place');
  const objects = items.filter((item) => item.kind === 'object');
  const colorOf = new Map(places.map((item, index) => [item.subjectId, CAST_SETS_SET_COLORS[index % CAST_SETS_SET_COLORS.length]]));
  const nameOf = (subjectId) => places.find((item) => item.subjectId === subjectId)?.name || 'No set identified';
  const { spans, bySet } = catalogSongMap(project, items);
  const setUse = (item) => {
    const use = bySet.get(item.subjectId);
    return { text: use ? `${plural(use.shots, 'shot')} · ${spanList(use.spans)}` : 'Not in a timed shot yet', off: !use };
  };

  const total = durationSec || spans.at(-1)?.endSec || 0;
  let cursor = 0;
  const segments = [];
  for (const span of spans) {
    const startSec = Math.max(span.startSec, cursor);
    if (span.endSec <= startSec) continue;
    if (startSec > cursor) segments.push({ startSec: cursor, endSec: startSec, gap: true });
    segments.push({ ...span, startSec });
    cursor = span.endSec;
  }
  if (total > cursor) segments.push({ startSec: cursor, endSec: total, gap: true });
  const bar = segments.map((segment) => {
    const label = segment.gap ? 'No shot' : nameOf(segment.subjectId);
    return `<div class="seg" style="flex:${Math.max(0.01, segment.endSec - segment.startSec).toFixed(2)};background:${segment.gap ? 'transparent' : colorOf.get(segment.subjectId) || NEUTRAL}" title="${e(label)} ${formatSheetTime(segment.startSec)}–${formatSheetTime(segment.endSec)}">${segment.gap ? '' : `<span>${e(label)}</span>`}</div>`;
  }).join('');
  const rowFor = (subjectId, label) => {
    const use = bySet.get(subjectId);
    return `<tr><td><span class="dot" style="background:${colorOf.get(subjectId) || NEUTRAL}"></span>${e(label)}</td><td class="tc">${plural(use?.shots ?? 0, 'shot')}</td><td class="tc">${formatSheetTime(use?.seconds)}</td><td>${use ? e(spanList(use.spans)) : 'Not in a timed shot yet'}</td></tr>`;
  };
  const rows = [...places.map((item) => rowFor(item.subjectId, item.name)), ...(bySet.has(null) ? [rowFor(null, 'No set identified')] : [])].join('');
  const songMap = spans.length
    ? `<div class="bar">${bar}</div><div class="ticks"><span>0:00</span><span>${formatSheetTime(total)}</span></div><div class="tablewrap"><table>${rows}</table></div>`
    : '<p class="sub">No timed shots yet. The map fills in the next time the guide is rebuilt after the shots are planned.</p>';

  const concept = project?.concept?.prompt?.trim();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)} — Cast &amp; Sets</title>
<style>${CAST_SETS_SHEET_STYLE}${CATALOG_STYLE}</style></head>
<body><div class="wrap">
<div class="hud"><span>Check-in <b>Cast &amp; Sets</b></span><span>Source <b>Catalog</b></span><span>Revision <b>${Number(revision) || 1}</b></span>${total ? `<span>Track ${formatSheetTime(total)}${bpm ? ` · ${Math.round(bpm)} BPM` : ''}</span>` : ''}<span>${plural(places.length, 'set')} · ${plural(objects.length, 'object')}</span></div>
<h1>${e(title)}</h1>
${concept ? `<p class="lede">${e(concept)}</p>` : ''}
${castSections}
${places.length ? `<section><h2><small>Sets</small>${plural(places.length, 'set')}</h2><p class="sub">Each set's images and text come from its catalog record.</p><div class="sets">${places.map((item) => subjectCard(item, { images, placeholder, mark: setUse(item) })).join('')}</div></section>` : ''}
${objects.length ? `<section><h2><small>Objects</small>${plural(objects.length, 'object')}</h2><p class="sub">Shots that show one of these use its catalog images.</p><div class="sets">${objects.map((item) => subjectCard(item, { images, placeholder })).join('')}</div></section>` : ''}
<section><h2><small>Song map</small>Where each set lives in the track</h2>${songMap}</section>
</div></body></html>
`;
}
