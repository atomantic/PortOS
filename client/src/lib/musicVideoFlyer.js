import { generateQrCodeSvg } from './qrCode.js';

/**
 * The printable 8.5×11 black-and-white release flyer for a music video: a
 * self-contained HTML page (preview iframe and print tab use the same text).
 * The QR points at `flyer.url` when given, else the release's YouTube link;
 * with neither it prints a dashed placeholder box, so the layout can be
 * proofed before publishing.
 */

export const FLYER_IMAGE_CHOICES = Object.freeze([
  { id: 'cover', label: 'Cover art' },
  { id: 'youtubeThumbnail', label: 'YouTube thumbnail' },
  { id: 'thumbnail', label: 'Best video frame' },
  { id: 'gallery', label: 'Gallery image…' },
  { id: 'none', label: 'No image' },
]);

/** Page designs: '80s' (VHS label, stacked outline title, speed stripes) or 'clean' (plain modern type). */
export const FLYER_STYLES = Object.freeze([
  { id: '80s', label: '80s' },
  { id: 'clean', label: 'Clean' },
]);

/** Sheet layouts: one flyer per letter page, or two half-letter flyers with a cut line. */
export const FLYER_LAYOUTS = Object.freeze([
  { id: 'full', label: 'Full page' },
  { id: 'half', label: '2 per page' },
]);

export const FLYER_TEXT_LIMITS = Object.freeze({ kicker: 60, title: 120, byline: 120, tagline: 300, scanLine: 60, printedLink: 120, details: 1200 });

const str = (v) => (typeof v === 'string' ? v : '');
const isUrl = (v) => /^https?:\/\//i.test(str(v).trim());

/** The image file each choice resolves to in the kit, as a `/data/...` path, or ''. */
export function flyerImagePath(kit, choice) {
  const k = kit && typeof kit === 'object' ? kit : {};
  const thumbs = (f) => (f ? `/data/video-thumbnails/${encodeURIComponent(f)}` : '');
  if (choice === 'cover') return thumbs(k.coverArt?.filename);
  if (choice === 'youtubeThumbnail') return thumbs(k.youtubeThumbnail?.filename);
  if (choice === 'thumbnail') return thumbs(k.thumbnail);
  if (choice === 'gallery') return k.flyer?.imageFile ? `/data/images/${encodeURIComponent(k.flyer.imageFile)}` : '';
  return '';
}

/** The first image choice this kit actually has, else 'none'. */
const defaultImageChoice = (kit) => FLYER_IMAGE_CHOICES.find((c) => c.id !== 'none' && flyerImagePath(kit, c.id))?.id || 'none';

/**
 * The flyer's fields: what the director saved (`kit.flyer`) over defaults from
 * the project. `qrUrl` is the link the QR encodes ('' = placeholder) and
 * `qrSource` says where it came from ('custom', 'youtube' or 'none').
 */
export function resolveFlyer(project, { youtubeUrl = '' } = {}) {
  const kit = project?.publishKit && typeof project.publishKit === 'object' ? project.publishKit : {};
  const saved = kit.flyer && typeof kit.flyer === 'object' ? kit.flyer : {};
  const pick = (key, fallback) => (typeof saved[key] === 'string' ? saved[key] : fallback);
  const custom = str(saved.url).trim();
  const youtube = str(youtubeUrl).trim();
  const qrSource = isUrl(custom) ? 'custom' : (isUrl(youtube) ? 'youtube' : 'none');
  const image = FLYER_IMAGE_CHOICES.some((c) => c.id === saved.image) ? saved.image : defaultImageChoice(kit);
  return {
    style: FLYER_STYLES.some((c) => c.id === saved.style) ? saved.style : '80s',
    layout: FLYER_LAYOUTS.some((c) => c.id === saved.layout) ? saved.layout : 'full',
    kicker: pick('kicker', 'New music video'),
    title: pick('title', str(project?.name)),
    byline: pick('byline', ''),
    tagline: pick('tagline', ''),
    scanLine: pick('scanLine', 'Scan to watch'),
    // Text printed under the QR (a short link people can type); the QR still encodes qrUrl.
    printedLink: pick('printedLink', ''),
    details: pick('details', ''),
    url: custom,
    image,
    imagePath: flyerImagePath(kit, image),
    qrUrl: qrSource === 'custom' ? custom : (qrSource === 'youtube' ? youtube : ''),
    qrSource,
  };
}

// The 80s page in black ink only: stacked outline title, tapered speed stripes,
// scanlines over the photo, a VHS cassette label around the QR.
const RETRO_CSS = `
.retro .kicker { font-family: "Courier New", Courier, monospace; letter-spacing: 0.25em; border-bottom: none; padding: 0; }
.retro .kicker::before { content: "\\25B6\\00A0"; }
.retro h1 { position: relative; font-style: italic; font-size: 66pt; letter-spacing: -0.02em; transform: skewX(-6deg); color: #fff; -webkit-text-stroke: 2.5pt #000; text-shadow: 3pt 3pt 0 #000, 6pt 6pt 0 #000; }
.retro .stripes { display: flex; flex-direction: column; gap: 3pt; margin-top: -0.06in; }
.retro .stripes i { display: block; background: #000; }
.retro .stripes i:nth-child(1) { height: 9pt; }
.retro .stripes i:nth-child(2) { height: 5pt; width: 88%; }
.retro .stripes i:nth-child(3) { height: 2pt; width: 76%; }
.retro .byline { font-family: "Courier New", Courier, monospace; text-transform: uppercase; letter-spacing: 0.15em; }
.retro .frame { border-width: 4pt; border-radius: 10pt; }
.retro .frame::after { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(to bottom, rgba(0,0,0,0.16) 0 1.2pt, transparent 1.2pt 3.6pt); pointer-events: none; }
.retro .tagline { font-family: "Courier New", Courier, monospace; font-size: 15pt; }
.retro .scan { border-width: 4pt; border-radius: 10pt; background: repeating-linear-gradient(to bottom, #fff 0 15pt, #000 15pt 16pt); padding: 0.18in 0.22in; }
.retro .text { background: #fff; padding: 0.08in 0.1in; border: 2pt solid #000; }
.retro .text h2 { font-style: italic; }
.retro .vhs { margin: 0 0 0.08in; font-family: "Courier New", Courier, monospace; font-size: 11pt; font-weight: 700; letter-spacing: 0.1em; }
.retro .vhs b { background: #000; color: #fff; padding: 1pt 5pt; margin-right: 4pt; font-style: italic; }
.retro .play { margin: 0.1in 0 0; font-family: "Courier New", Courier, monospace; font-size: 10pt; font-weight: 700; }
.retro .qr { background: #fff; border: 2pt solid #000; }
.retro .hero img { max-width: calc(100cqw - 8pt); max-height: calc(100cqh - 8pt); }
.retro .qr.placeholder { border-style: dashed; }
.retro .details { font-family: "Courier New", Courier, monospace; font-size: 11pt; }
`;

// Two 8.5×5.5 flyers stacked on one letter sheet: text and image on the left,
// the QR as large as the half allows on the right, a dashed cut line between.
const HALF_CSS = `
.page.half { height: 5.45in; padding: 0.4in 0.45in; gap: 0.1in; }
.half .row { display: flex; gap: 0.3in; flex: 1 1 auto; }
.half .info { display: flex; flex-direction: column; gap: 0.12in; flex: 1 1 auto; min-width: 0; }
.half .kicker { font-size: 10pt; padding-bottom: 0.05in; }
.half h1 { font-size: 38pt; }
.half .stripes i:nth-child(1) { height: 6pt; }
.half .stripes i:nth-child(2) { height: 3pt; }
.half .stripes i:nth-child(3) { height: 1.5pt; }
.half .byline { font-size: 13pt; }
.half .hero { max-height: none; }
.half .tagline { font-size: 12pt; }
.half .details { font-size: 9pt; column-count: 2; column-gap: 0.3in; }
.half .scan { padding: 0.14in; flex: 0 0 auto; }
.half .qrslot { width: 3.5in; align-self: stretch; }
.half.noimg .qrslot { width: 4.1in; }
.half .text { padding: 0.06in 0.1in; border: 2pt solid #000; }
.half .text h2 { font-size: 18pt; margin: 0 0 0.04in; }
.half .url { font-size: 10pt; }
.half .vhs { font-size: 8pt; margin: 0 0 0.04in; }
.half .play { font-size: 8pt; margin-top: 0.04in; }

.half .qr.placeholder { font-size: 11pt; }
.cut { height: 0.1in; border-top: 1.5pt dashed #000; position: relative; font-size: 14pt; line-height: 0; padding-left: 0.2in; }
`;

const escapeHtml = (s) => str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = (s) => escapeHtml(s).split('\n').join('<br>');
// The printed link reads cleaner without the scheme; the QR keeps the full URL.
const displayUrl = (url) => str(url).replace(/^https?:\/\//i, '').replace(/\/$/, '');

/**
 * The flyer as a full HTML document. `origin` makes image paths absolute so
 * the page also works from a blob: tab. `autoPrint` opens the print dialog
 * once the image has loaded.
 */
export function buildFlyerHtml(flyer, { origin = '', autoPrint = false } = {}) {
  const f = flyer || {};
  const image = f.imagePath ? `${origin}${f.imagePath}` : '';
  const qr = f.qrUrl
    ? `<div class="qr" role="img" aria-label="QR code for ${escapeHtml(f.qrUrl)}">${generateQrCodeSvg(f.qrUrl, { size: 240, ecc: 'Q' })}</div>`
    : '<div class="qr placeholder">QR code<br>goes here once<br>the YouTube link<br>is in</div>';
  const retro = f.style !== 'clean';
  const half = f.layout === 'half';
  const shown = str(f.printedLink).trim() || f.qrUrl;
  const urlLine = shown ? `<p class="url">${escapeHtml(displayUrl(shown))}</p>` : '<p class="url muted">youtube link pending</p>';
  // The label beside the QR; on a half sheet it moves to the text column so the QR gets the whole right side.
  const label = `<div class="text">${retro ? '<p class="vhs" aria-hidden="true"><b>VHS</b> HI-FI STEREO · SP</p>' : ''}<h2>${escapeHtml(f.scanLine || 'Scan to watch')}</h2>${urlLine}${retro ? '<p class="play" aria-hidden="true">▶ PLAY &nbsp; ◀◀ REW &nbsp; ▶▶ FF</p>' : ''}</div>`;
  const page = `<main class="page${half ? ' half' : ''}${image ? '' : ' noimg'}">${half ? '<div class="row">' : ''}<div class="info">
${f.kicker ? `<p class="kicker">${escapeHtml(f.kicker)}</p>` : ''}
${f.title ? `<h1>${escapeHtml(f.title)}</h1>` : ''}
${retro ? '<div class="stripes" aria-hidden="true"><i></i><i></i><i></i></div>' : ''}
${f.byline ? `<p class="byline">${escapeHtml(f.byline)}</p>` : ''}
${image ? `<div class="hero"><div class="frame"><img src="${escapeHtml(image)}" alt=""></div></div>` : ''}
${f.tagline ? `<p class="tagline">${lines(f.tagline)}</p>` : ''}
${half ? label : ''}
</div>
<section class="scan">${half ? '' : label}<div class="qrslot">${qr}</div></section>
${half ? '</div>' : ''}
${f.details ? `<p class="details">${lines(f.details)}</p>` : ''}
</main>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=816">
<title>${escapeHtml(f.title || 'Flyer')} flyer</title>
<style>
@page { size: letter; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
.page { width: 8.5in; height: 11in; padding: 0.55in; display: flex; flex-direction: column; gap: 0.22in; overflow: hidden; }
.info { display: contents; }
/* No image on a full page: the QR takes the room, stacked over its label. */
.page.noimg:not(.half) .scan { flex-direction: column-reverse; gap: 0.15in; }
.page.noimg:not(.half) .scan .text { text-align: center; flex: 0 0 auto; }
.page.noimg:not(.half) { gap: 0.12in; padding: 0.4in 0.5in; }
.page.noimg:not(.half) .scan { padding: 0.12in; }
.page.noimg:not(.half) .text h2 { font-size: 24pt; margin: 0; }
.page.noimg:not(.half) .vhs, .page.noimg:not(.half) .play { display: none; }
.page.noimg:not(.half) .scan { flex: 1 1 auto; min-height: 0; }
.page.noimg:not(.half) .qrslot { flex: 1 1 auto; min-height: 0; align-self: stretch; }
.kicker { margin: 0; font-size: 15pt; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; border-bottom: 3pt solid #000; padding-bottom: 0.08in; }
h1 { margin: 0; font-family: "Arial Black", "Helvetica Neue", Arial, sans-serif; font-weight: 900; font-size: 58pt; line-height: 0.95; text-transform: uppercase; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.byline { margin: 0; font-size: 20pt; font-weight: 700; }
/* The hero takes the space left over; the framed image fits inside it whole (never cropped). */
.hero { flex: 1 1 auto; min-height: 0; max-height: 3in; container-type: size; display: flex; align-items: center; justify-content: center; }
.frame { position: relative; display: flex; border: 3pt solid #000; overflow: hidden; }
.hero img { display: block; max-width: calc(100cqw - 6pt); max-height: calc(100cqh - 6pt); width: auto; height: auto; filter: grayscale(1) contrast(1.15); }
.tagline { margin: 0; font-size: 17pt; line-height: 1.3; }
.scan { display: flex; gap: 0.3in; align-items: center; border: 3pt solid #000; padding: 0.2in; }
.scan .text { flex: 1 1 auto; min-width: 0; }
.text h2 { margin: 0 0 0.08in; font-family: "Arial Black", "Helvetica Neue", Arial, sans-serif; font-size: 30pt; text-transform: uppercase; line-height: 1; }
.url { margin: 0; font-family: "Courier New", Courier, monospace; font-size: 13pt; overflow-wrap: anywhere; }
.muted { color: #555; }
/* A slot that sizes its QR to whatever room the text leaves, capped per layout. */
.qrslot { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
.qr { width: 3.3in; height: 3.3in; flex: 0 0 auto; }
.half .qrslot, .page.noimg .qrslot { container-type: size; }
.half .qr, .page.noimg .qr { width: min(100cqw, 100cqh); height: min(100cqw, 100cqh); }
.page.noimg:not(.half) .qr { width: min(6.2in, 100cqw, 100cqh); height: min(6.2in, 100cqw, 100cqh); }
.qr svg { width: 100%; height: 100%; display: block; }
.qr.placeholder { border: 2pt dashed #000; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 13pt; font-weight: 700; text-transform: uppercase; line-height: 1.4; }
.details { margin: 0; font-size: 12pt; line-height: 1.4; }
${retro ? RETRO_CSS : ''}
${half ? HALF_CSS : ''}
</style></head>
<body class="${[retro ? 'retro' : '', half ? 'halves' : ''].join(' ').trim()}">${half ? `${page}<div class="cut" aria-hidden="true">✂</div>${page}` : page}${autoPrint ? `<script>
(function () {
  var go = function () { setTimeout(function () { window.print(); }, 150); };
  var img = document.querySelector('.hero img');
  if (img && !img.complete) { img.addEventListener('load', go); img.addEventListener('error', go); } else { go(); }
})();
</script>` : ''}</body></html>`;
}
