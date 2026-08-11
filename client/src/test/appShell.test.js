/**
 * App-shell (`client/index.html`) boot guards.
 *
 * PortOS installs run on a private Tailscale network and are expected to work
 * with no route to the public internet — that is the premise of the offline
 * app-shell service worker in `public/sw.js`. A render-blocking stylesheet
 * pointed at a THIRD-PARTY host breaks that premise outright: when the host is
 * unreachable (no WAN, DNS sinkhole, outbound firewall) the browser holds the
 * first paint until the request times out, so the app is a blank white page for
 * ~60s on every load — with or without the service worker, because the SW's own
 * `fetch` for the stylesheet hangs the same way. #3808 fixed that symptom by
 * loading the Google Fonts sheet non-blocking.
 *
 * #3812 removed the third-party host entirely: Inter and IBM Plex Mono are now
 * self-hosted under `public/fonts/` and declared with `@font-face` in
 * `src/index.css`. That is what makes the themed typography actually *render*
 * offline rather than merely fail quietly — four stacks in
 * `themes/portosThemes.js` front Inter and one fronts IBM Plex Mono, and a font
 * that never arrives silently degrades every one of them to a system fallback.
 *
 * So these guards cover both halves: the shell must not reach for a font CDN,
 * and every `@font-face` it relies on must resolve to a file that is really in
 * the tree.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(CLIENT_ROOT, 'index.html'), 'utf8');
const css = readFileSync(join(CLIENT_ROOT, 'src', 'index.css'), 'utf8');

// `<noscript>` content is inert while JS is enabled, so a blocking stylesheet
// in there can't stall the app's boot. With JS off the SPA can't render at all,
// which makes it moot — so the render-blocking guard scans the shell WITHOUT
// noscript blocks, or it would flag its own graceful-degradation fallback.
const htmlWithoutNoscript = html.replace(/<noscript>.*?<\/noscript>/gs, '');
const activeLinkTags = htmlWithoutNoscript.match(/<link\b[^>]*>/gs) || [];

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 's'));
  return m ? m[1] : null;
};

const isStylesheet = (tag) => attr(tag, 'rel') === 'stylesheet';
const isCrossOrigin = (tag) => /^https?:\/\//.test(attr(tag, 'href') || '');

// A stylesheet only blocks the first paint when its media query matches the
// screen. `media="print"` (flipped to `all` by onload) downloads without
// blocking — the standard non-blocking-CSS pattern.
const isRenderBlocking = (tag) => {
  const media = attr(tag, 'media');
  return media === null || media === 'all' || media === 'screen';
};

describe('client/index.html — boot must not depend on a third-party host', () => {
  it('has no render-blocking cross-origin stylesheet', () => {
    const offenders = activeLinkTags
      .filter((t) => isStylesheet(t) && isCrossOrigin(t) && isRenderBlocking(t))
      .map((t) => attr(t, 'href'));

    expect(offenders).toEqual([]);
  });

  it('references no Google Fonts host at all — not even non-blocking', () => {
    // Non-blocking was the #3808 stopgap; it kept boot fast but left the fonts
    // permanently unreachable offline. Self-hosting made every reference dead,
    // including the `<noscript>` fallback and both `preconnect` hints. Scanned
    // RAW (comments included) — Vite copies HTML comments into dist, so a
    // commented-out `<link>` would ship the hostname to every install and is
    // one uncomment away from regressing.
    expect(html).not.toMatch(/fonts\.googleapis\.com/);
    expect(html).not.toMatch(/fonts\.gstatic\.com/);
  });
});

describe('self-hosted webfonts', () => {
  // Every `url('/fonts/…')` in index.css, in source order.
  const fontUrls = [...css.matchAll(/url\(\s*['"]?(\/fonts\/[^'")]+)['"]?\s*\)/g)].map((m) => m[1]);

  it('resolves every @font-face url to a file that exists in public/', () => {
    expect(fontUrls.length).toBeGreaterThan(0);

    const missing = fontUrls.filter((u) => !existsSync(join(CLIENT_ROOT, 'public', u)));

    expect(missing).toEqual([]);
  });

  it('declares the exact family/weight pairs the theme stacks front', () => {
    // themes/portosThemes.js fronts `Inter` in four `--port-font-ui` stacks and
    // `IBM Plex Mono` in one `--port-font-mono` stack. A weight declared in a
    // stack but missing here gets synthesized by the browser (faux bold), which
    // is the subtle regression this pins.
    const declared = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)]
      .map((m) => m[1])
      // Tolerate `'Inter'`, `"Inter"` and bare `Inter` — a single-quote-only
      // match would read a reformatted-but-correct block as family `undefined`
      // and fail with a missing weight instead of the real problem.
      .map((block) => ({
        family: block.match(/font-family:\s*['"]?([^'";]+)['"]?/)?.[1]?.trim(),
        weight: Number(block.match(/font-weight:\s*(\d+)/)?.[1]),
      }))
      .filter((d) => d.family === 'Inter' || d.family === 'IBM Plex Mono');

    const weightsFor = (family) =>
      declared
        .filter((d) => d.family === family)
        .map((d) => d.weight)
        .sort((a, b) => a - b);

    expect(weightsFor('Inter')).toEqual([400, 500, 600, 700]);
    expect(weightsFor('IBM Plex Mono')).toEqual([400, 500, 600]);
  });

  it('uses font-display: swap on every self-hosted face', () => {
    // Without `swap` a face that is slow to load blocks its own text for the
    // browser's block period — the local-server equivalent of the blank-page
    // failure this whole guard file exists for.
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    const withoutSwap = faces.filter((block) => !/font-display:\s*swap/.test(block));

    expect(withoutSwap).toEqual([]);
  });

  it('ships an OFL license beside each vendored family', () => {
    // Inter and IBM Plex Mono are both SIL Open Font License 1.1, which permits
    // vendoring only with the license text alongside.
    for (const license of ['Inter-OFL.txt', 'IBMPlexMono-OFL.txt']) {
      const path = join(CLIENT_ROOT, 'public', 'fonts', license);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toMatch(/SIL OPEN FONT LICENSE/i);
    }
  });
});

describe('client/public/sw.js — no dead font-host caching', () => {
  const sw = readFileSync(join(CLIENT_ROOT, 'public', 'sw.js'), 'utf8');

  it('no longer routes requests to the Google font hosts', () => {
    // `public/sw.js` is copied to dist verbatim, comments and all — same
    // reasoning as the shell above, so this is a raw scan too.
    expect(sw).not.toMatch(/fonts\.googleapis\.com/);
    expect(sw).not.toMatch(/fonts\.gstatic\.com/);
  });

  it('still caches same-origin /fonts/ as a static asset', () => {
    // The self-hosted files ride the existing static-asset path, so dropping
    // the dedicated font cache costs nothing offline.
    expect(sw).toMatch(/STATIC_PATH_RE\s*=\s*\/\^\\\/\(fonts\|/);
  });
});
