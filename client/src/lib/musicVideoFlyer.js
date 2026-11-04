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

export const FLYER_TEXT_LIMITS = Object.freeze({ kicker: 60, title: 120, byline: 120, tagline: 300, scanLine: 60, details: 1200 });

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
    kicker: pick('kicker', 'New music video'),
    title: pick('title', str(project?.name)),
    byline: pick('byline', ''),
    tagline: pick('tagline', ''),
    scanLine: pick('scanLine', 'Scan to watch'),
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
.retro .hero { position: relative; border-width: 4pt; border-radius: 10pt; }
.retro .hero::after { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(to bottom, rgba(0,0,0,0.16) 0 1.2pt, transparent 1.2pt 3.6pt); pointer-events: none; }
.retro .tagline { font-family: "Courier New", Courier, monospace; font-size: 15pt; }
.retro .scan { border-width: 4pt; border-radius: 10pt; background: repeating-linear-gradient(to bottom, #fff 0 15pt, #000 15pt 16pt); padding: 0.18in 0.22in; }
.retro .scan .text { background: #fff; padding: 0.08in 0.1in; border: 2pt solid #000; }
.retro .scan h2 { font-style: italic; }
.retro .vhs { margin: 0 0 0.08in; font-family: "Courier New", Courier, monospace; font-size: 11pt; font-weight: 700; letter-spacing: 0.1em; }
.retro .vhs b { background: #000; color: #fff; padding: 1pt 5pt; margin-right: 4pt; font-style: italic; }
.retro .play { margin: 0.1in 0 0; font-family: "Courier New", Courier, monospace; font-size: 10pt; font-weight: 700; }
.retro .qr { background: #fff; border: 2pt solid #000; }
.retro .qr.placeholder { border-style: dashed; }
.retro .details { font-family: "Courier New", Courier, monospace; font-size: 11pt; }
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
  const urlLine = f.qrUrl ? `<p class="url">${escapeHtml(displayUrl(f.qrUrl))}</p>` : '<p class="url muted">youtube link pending</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=816">
<title>${escapeHtml(f.title || 'Flyer')} flyer</title>
<style>
@page { size: letter; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
.page { width: 8.5in; height: 11in; padding: 0.55in; display: flex; flex-direction: column; gap: 0.22in; overflow: hidden; }
.kicker { margin: 0; font-size: 15pt; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; border-bottom: 3pt solid #000; padding-bottom: 0.08in; }
h1 { margin: 0; font-family: "Arial Black", "Helvetica Neue", Arial, sans-serif; font-weight: 900; font-size: 58pt; line-height: 0.95; text-transform: uppercase; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.byline { margin: 0; font-size: 20pt; font-weight: 700; }
.hero { flex: 1 1 auto; min-height: 0; border: 3pt solid #000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.hero img { width: 100%; height: 100%; object-fit: cover; filter: grayscale(1) contrast(1.15); }
.tagline { margin: 0; font-size: 17pt; line-height: 1.3; }
.scan { display: flex; gap: 0.3in; align-items: center; border: 3pt solid #000; padding: 0.2in; }
.scan .text { flex: 1 1 auto; min-width: 0; }
.scan h2 { margin: 0 0 0.08in; font-family: "Arial Black", "Helvetica Neue", Arial, sans-serif; font-size: 30pt; text-transform: uppercase; line-height: 1; }
.url { margin: 0; font-family: "Courier New", Courier, monospace; font-size: 13pt; overflow-wrap: anywhere; }
.muted { color: #555; }
.qr { width: 2.5in; height: 2.5in; flex: 0 0 auto; }
.qr svg { width: 100%; height: 100%; display: block; }
.qr.placeholder { border: 2pt dashed #000; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 13pt; font-weight: 700; text-transform: uppercase; line-height: 1.4; }
.details { margin: 0; font-size: 12pt; line-height: 1.4; }
${retro ? RETRO_CSS : ''}
</style></head>
<body${retro ? ' class="retro"' : ''}><main class="page">
${f.kicker ? `<p class="kicker">${escapeHtml(f.kicker)}</p>` : ''}
${f.title ? `<h1>${escapeHtml(f.title)}</h1>` : ''}
${retro ? '<div class="stripes" aria-hidden="true"><i></i><i></i><i></i></div>' : ''}
${f.byline ? `<p class="byline">${escapeHtml(f.byline)}</p>` : ''}
${image ? `<div class="hero"><img src="${escapeHtml(image)}" alt=""></div>` : '<div class="hero" style="border:none"></div>'}
${f.tagline ? `<p class="tagline">${lines(f.tagline)}</p>` : ''}
<section class="scan"><div class="text">${retro ? '<p class="vhs" aria-hidden="true"><b>VHS</b> HI-FI STEREO · SP</p>' : ''}<h2>${escapeHtml(f.scanLine || 'Scan to watch')}</h2>${urlLine}${retro ? '<p class="play" aria-hidden="true">▶ PLAY &nbsp; ◀◀ REW &nbsp; ▶▶ FF</p>' : ''}</div>${qr}</section>
${f.details ? `<p class="details">${lines(f.details)}</p>` : ''}
</main>${autoPrint ? `<script>
(function () {
  var go = function () { setTimeout(function () { window.print(); }, 150); };
  var img = document.querySelector('.hero img');
  if (img && !img.complete) { img.addEventListener('load', go); img.addEventListener('error', go); } else { go(); }
})();
</script>` : ''}</body></html>`;
}
