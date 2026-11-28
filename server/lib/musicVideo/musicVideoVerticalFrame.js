/**
 * Shared 9:16 framed vertical layout (1080x1920) for TikTok / Reels / Shorts,
 * placing the uncropped 16:9 master inside TikTok's safe window with a header and synced footer.
 *
 * Pure module shared by the client live preview (PublishVerticalPreview) and the
 * server sharp+FFmpeg encoder (verticalFrameRender), so preview and export match.
 */

export const VERTICAL_FRAME_WIDTH = 1080;
export const VERTICAL_FRAME_HEIGHT = 1920;
export const VERTICAL_FOOTER_Y = 1094;
export const VERTICAL_FOOTER_HEIGHT = 366;

/** TikTok UI chrome areas on a 1080x1920 canvas (used for the preview safe-zone HUD). */
export const VERTICAL_SAFE_ZONES = Object.freeze({
  top: Object.freeze({ x: 0, y: 0, width: 1080, height: 240, label: 'TikTok top tabs' }),
  right: Object.freeze({ x: 920, y: 980, width: 160, height: 600, label: 'UI rail' }),
  bottom: Object.freeze({ x: 0, y: 1460, width: 1080, height: 460, label: 'Caption & audio' }),
});

export const VERTICAL_FRAME_THEMES = Object.freeze({
  'cinema-matte': Object.freeze({
    id: 'cinema-matte',
    label: 'Cinema matte',
    videoRect: Object.freeze({ x: 0, y: 486, width: 1080, height: 608, radius: 0 }),
    backdropDim: 0.62,
    backdropBlurPx: 28,
    accent: '#f59e0b',
    titleColor: '#f8fafc',
    subtitleColor: 'rgba(226,232,240,0.78)',
    lyricColor: '#ffffff',
    nextLyricColor: 'rgba(226,232,240,0.45)',
    borderColor: 'rgba(255,255,255,0.16)',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
    monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  }),
  'analog-16mm': Object.freeze({
    id: 'analog-16mm',
    label: '16mm film print',
    videoRect: Object.freeze({ x: 36, y: 502, width: 1008, height: 568, radius: 4 }),
    backdropDim: 0.72,
    backdropBlurPx: 24,
    accent: '#f5b041',
    titleColor: '#f5ecd7',
    subtitleColor: 'rgba(245,236,215,0.72)',
    lyricColor: '#fdf6e3',
    nextLyricColor: 'rgba(245,236,215,0.42)',
    borderColor: 'rgba(245,176,65,0.34)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    sprockets: true,
  }),
  'ambient-glow': Object.freeze({
    id: 'ambient-glow',
    label: 'Ambient glow',
    videoRect: Object.freeze({ x: 24, y: 494, width: 1032, height: 580, radius: 18 }),
    backdropDim: 0.42,
    backdropBlurPx: 36,
    accent: '#fbbf24',
    titleColor: '#ffffff',
    subtitleColor: 'rgba(255,255,255,0.82)',
    lyricColor: '#ffffff',
    nextLyricColor: 'rgba(255,255,255,0.52)',
    borderColor: 'rgba(255,255,255,0.28)',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
    monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  }),
});

export const VERTICAL_FRAME_THEME_IDS = Object.freeze(Object.keys(VERTICAL_FRAME_THEMES));

export const DEFAULT_VERTICAL_FRAME_OPTIONS = Object.freeze({
  theme: 'cinema-matte',
  title: '',
  subtitle: '',
  footerNote: '',
  showLyrics: false,
  showWaveform: true,
});

export function resolveVerticalFrameTheme(themeId) {
  return VERTICAL_FRAME_THEMES[themeId] || VERTICAL_FRAME_THEMES['cinema-matte'];
}

/** Escape text for safe embedding inside SVG elements. */
export function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/** Extract sorted timed lyric lines from a project (`lyricCues`), ready for preview and render. */
export function projectTimedLyricLines(project) {
  const cues = Array.isArray(project?.lyricCues) ? project.lyricCues : [];
  return cues
    .filter((c) => c && typeof c.text === 'string' && c.text.trim() && finite(c.startSec) != null)
    .map((c) => ({
      text: c.text.replace(/\s+/g, ' ').trim(),
      startSec: c.startSec,
      endSec: finite(c.endSec) != null && c.endSec > c.startSec ? c.endSec : c.startSec + 4,
    }))
    .sort((a, b) => a.startSec - b.startSec);
}

/** Whether the project's 16:9 master already draws overlay lyrics over the video. */
export function masterBurnsOverlayLyrics(project) {
  if (typeof project?.lyricOverlayEnabled === 'boolean') return project.lyricOverlayEnabled;
  // Document compositions default to drawing lyrics unless explicitly disabled.
  return project?.composition?.mode === 'document';
}

/** Sensible defaults for the framed 9:16 header/footer options from a project record. */
export function defaultVerticalFrameOptions(project) {
  const title = String(project?.titleCard?.title || project?.title || project?.name || '').trim().slice(0, 120);
  const artist = String(project?.titleCard?.artist || project?.artistName || '').trim();
  const subtitle = (artist ? `${artist} · Official Music Video` : 'Official Music Video').slice(0, 160);
  const hasLyrics = projectTimedLyricLines(project).length > 0;
  // Avoid duplicating lyrics if the 16:9 master already renders overlay lyrics; enable by default when the master is lyric-free.
  const showLyrics = hasLyrics && !masterBurnsOverlayLyrics(project);
  return {
    theme: 'cinema-matte',
    title,
    subtitle,
    footerNote: '',
    showLyrics,
    showWaveform: true,
  };
}

/** Active and upcoming lyric line at `timeSec` (with a small lead-in for smooth reading). */
export function activeLyricPair(lines, timeSec) {
  if (!Array.isArray(lines) || !lines.length || !Number.isFinite(timeSec)) return { current: null, next: null };
  let current = null;
  let next = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (timeSec >= line.startSec - 0.12 && timeSec <= line.endSec + 0.25) {
      current = line;
      next = lines[i + 1] || null;
      break;
    }
    if (line.startSec > timeSec) {
      next = line;
      break;
    }
  }
  return { current, next };
}

/** Wrap a lyric or title into at most `maxLines` lines capped at `maxChars` characters each. */
export function wrapTextLines(text, maxChars = 34, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
    } else {
      lines.push(current);
      if (lines.length === maxLines - 1) {
        current = word;
      } else {
        current = word;
      }
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length + 1) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = `${last.slice(0, Math.max(1, maxChars - 1)).replace(/\s+\S*$/, '')}…`;
  }
  return lines;
}

const fmtClock = (sec) => {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Static 1080x1920 transparent SVG chrome: readability scrims, frame border/sprockets,
 * and header title + subtitle safely centered between TikTok's top tabs (y=240) and
 * the 16:9 cinema window (y=486).
 */
export function verticalFrameStaticSvg({ theme: themeId = 'cinema-matte', title = '', subtitle = '' } = {}) {
  const t = resolveVerticalFrameTheme(themeId);
  const { x, y, width, height, radius } = t.videoRect;
  const titleLines = wrapTextLines(title, t.id === 'analog-16mm' ? 24 : 26, 2);
  const cleanSubtitle = String(subtitle || '').trim().slice(0, 68);
  const headerCenterY = 348;
  const titleSize = titleLines.length > 1 ? 46 : 54;
  const titleBlockY = titleLines.length > 1 ? headerCenterY - 24 : headerCenterY + 6;

  // 16mm sprocket rails along the left and right edges (outside the 1008px cinema frame).
  let sprocketsSvg = '';
  if (t.sprockets) {
    const holes = [];
    for (let sy = 250; sy < 1440; sy += 64) {
      holes.push(`<rect x="8" y="${sy}" width="18" height="32" rx="4" fill="rgba(245,236,215,0.16)"/>`);
      holes.push(`<rect x="1054" y="${sy}" width="18" height="32" rx="4" fill="rgba(245,236,215,0.16)"/>`);
    }
    sprocketsSvg = `<g>${holes.join('')}</g>`;
  }

  const titleMarkup = titleLines.map((line, i) => (
    `<text x="540" y="${titleBlockY + i * (titleSize + 8)}" text-anchor="middle" fill="${t.titleColor}" font-family='${t.fontFamily}' font-size="${titleSize}" font-weight="700" letter-spacing="${t.id === 'analog-16mm' ? '3' : '1'}">${escapeSvgText(line)}</text>`
  )).join('');

  const subY = titleLines.length ? titleBlockY + (titleLines.length - 1) * (titleSize + 8) + 46 : headerCenterY + 10;
  const subtitleMarkup = cleanSubtitle
    ? `<text x="540" y="${subY}" text-anchor="middle" fill="${t.subtitleColor}" font-family='${t.monoFamily}' font-size="23" font-weight="500" letter-spacing="2.2">${escapeSvgText(cleanSubtitle.toUpperCase())}</text>`
    : '';

  const accentRule = titleLines.length || cleanSubtitle
    ? `<rect x="488" y="456" width="104" height="3" rx="1.5" fill="${t.accent}" opacity="0.85"/>`
    : '';

  const frameBorder = radius > 0
    ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="none" stroke="${t.borderColor}" stroke-width="2"/>`
    : `<line x1="0" y1="${y}" x2="1080" y2="${y}" stroke="${t.borderColor}" stroke-width="2"/><line x1="0" y1="${y + height}" x2="1080" y2="${y + height}" stroke="${t.borderColor}" stroke-width="2"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VERTICAL_FRAME_WIDTH}" height="${VERTICAL_FRAME_HEIGHT}" viewBox="0 0 ${VERTICAL_FRAME_WIDTH} ${VERTICAL_FRAME_HEIGHT}">`,
    '<defs>',
    '<linearGradient id="topScrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000000" stop-opacity="0.72"/><stop offset="100%" stop-color="#000000" stop-opacity="0.18"/></linearGradient>',
    '<linearGradient id="botScrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000000" stop-opacity="0.18"/><stop offset="55%" stop-color="#000000" stop-opacity="0.58"/><stop offset="100%" stop-color="#000000" stop-opacity="0.86"/></linearGradient>',
    '</defs>',
    `<rect x="0" y="0" width="1080" height="${y}" fill="url(#topScrim)"/>`,
    `<rect x="0" y="${y + height}" width="1080" height="${VERTICAL_FRAME_HEIGHT - (y + height)}" fill="url(#botScrim)"/>`,
    sprocketsSvg,
    titleMarkup,
    subtitleMarkup,
    accentRule,
    frameBorder,
    '</svg>',
  ].join('');
}

/** Deterministic beat-reactive pulse (0..1) near any beat timestamp for the waveform bars. */
function beatPulse(beats, timeSec) {
  if (!Array.isArray(beats) || !beats.length) return 0.35 + 0.25 * Math.sin(timeSec * 4.2);
  let best = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const d = Math.abs(beats[i] - timeSec);
    if (d < best) best = d;
    if (beats[i] > timeSec + 0.5) break;
  }
  return Math.max(0, 1 - best / 0.24);
}

/**
 * Dynamic 1080x366 transparent footer SVG overlaid at y=1094 (strictly above TikTok's
 * bottom caption zone at y=1460): active synced lyrics, optional footer note, subtle
 * beat-reactive waveform, and song progress bar with timecode.
 */
export function verticalFrameDynamicSvg({
  theme: themeId = 'cinema-matte',
  timeSec = 0,
  startSec = 0,
  endSec = 1,
  lyrics = [],
  beats = [],
  showLyrics = false,
  showWaveform = true,
  footerNote = '',
} = {}) {
  const t = resolveVerticalFrameTheme(themeId);
  const span = Math.max(0.001, endSec - startSec);
  const elapsed = Math.max(0, Math.min(span, timeSec - startSec));
  const progress = Math.max(0, Math.min(1, elapsed / span));
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VERTICAL_FRAME_WIDTH}" height="${VERTICAL_FOOTER_HEIGHT}" viewBox="0 0 ${VERTICAL_FRAME_WIDTH} ${VERTICAL_FOOTER_HEIGHT}">`,
  ];

  // 1. Synced lyrics in the upper portion of the footer (y: 44..205 inside the 366px strip).
  if (showLyrics) {
    const { current, next } = activeLyricPair(lyrics, timeSec);
    if (current) {
      const wrapped = wrapTextLines(current.text, 30, 2);
      const size = wrapped.length > 1 ? 36 : 42;
      const baseY = wrapped.length > 1 ? 82 : 104;
      wrapped.forEach((line, idx) => {
        parts.push(`<text x="540" y="${baseY + idx * (size + 10)}" text-anchor="middle" fill="${t.lyricColor}" font-family='${t.fontFamily}' font-size="${size}" font-weight="600">${escapeSvgText(line)}</text>`);
      });
    }
    if (next) {
      const preview = wrapTextLines(next.text, 42, 1)[0] || '';
      if (preview) {
        parts.push(`<text x="540" y="182" text-anchor="middle" fill="${t.nextLyricColor}" font-family='${t.fontFamily}' font-size="24" font-weight="400">${escapeSvgText(preview)}</text>`);
      }
    }
  } else if (String(footerNote || '').trim()) {
    const noteLines = wrapTextLines(footerNote, 40, 2);
    noteLines.forEach((line, idx) => {
      parts.push(`<text x="540" y="${96 + idx * 36}" text-anchor="middle" fill="${t.subtitleColor}" font-family='${t.fontFamily}' font-size="27" font-weight="500">${escapeSvgText(line)}</text>`);
    });
  }

  // 2. Subtle beat-reactive waveform + progress bar + timecode (y: 220..336).
  // Kept left-inset of the right action rail (x: 96..880) so TikTok's buttons never cover the clock!
  const barLeft = 96;
  const barWidth = 780;
  if (showWaveform) {
    const pulse = beatPulse(beats, timeSec);
    const barCount = 36;
    const step = barWidth / barCount;
    const waveY = 252;
    for (let i = 0; i < barCount; i++) {
      const u = i / (barCount - 1);
      const envelope = Math.sin(u * Math.PI);
      const wave = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.72 + timeSec * 5.4) * Math.cos(i * 0.31 - timeSec * 2.1));
      const h = Math.max(6, Math.round((10 + 34 * envelope * (0.45 + 0.55 * pulse) * wave)));
      const bx = Math.round(barLeft + i * step + 4);
      const played = u <= progress;
      parts.push(`<rect x="${bx}" y="${Math.round(waveY - h / 2)}" width="${Math.max(4, Math.round(step - 10))}" height="${h}" rx="3" fill="${played ? t.accent : 'rgba(255,255,255,0.24)'}" opacity="${played ? '0.92' : '0.7'}"/>`);
    }
  }

  // Clean progress bar + clock (always shown in the footer).
  const trackY = 296;
  const fillW = Math.max(4, Math.round(barWidth * progress));
  parts.push(`<rect x="${barLeft}" y="${trackY}" width="${barWidth}" height="6" rx="3" fill="rgba(255,255,255,0.2)"/>`);
  parts.push(`<rect x="${barLeft}" y="${trackY}" width="${fillW}" height="6" rx="3" fill="${t.accent}"/>`);
  parts.push(`<text x="${barLeft}" y="${trackY + 34}" text-anchor="start" fill="${t.subtitleColor}" font-family='${t.monoFamily}' font-size="22">${fmtClock(elapsed)}</text>`);
  parts.push(`<text x="${barLeft + barWidth}" y="${trackY + 34}" text-anchor="end" fill="${t.subtitleColor}" font-family='${t.monoFamily}' font-size="22">${fmtClock(span)}</text>`);

  if (showLyrics && String(footerNote || '').trim()) {
    const note = String(footerNote).trim().slice(0, 48);
    parts.push(`<text x="${barLeft + Math.round(barWidth / 2)}" y="${trackY + 34}" text-anchor="middle" fill="${t.nextLyricColor}" font-family='${t.monoFamily}' font-size="20">${escapeSvgText(note)}</text>`);
  }

  parts.push('</svg>');
  return parts.join('');
}

/** Toggleable 1080x1920 safe-zone HUD SVG for the live browser preview. */
export function verticalSafeZonesSvg() {
  const { top, right, bottom } = VERTICAL_SAFE_ZONES;
  const box = (z, color) => [
    `<rect x="${z.x}" y="${z.y}" width="${z.width}" height="${z.height}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-opacity="0.75" stroke-width="3" stroke-dasharray="14 10"/>`,
    `<text x="${z.x + z.width / 2}" y="${z.y + z.height / 2 + 8}" text-anchor="middle" fill="#ffffff" font-family="ui-monospace, monospace" font-size="26" font-weight="700">${escapeSvgText(z.label.toUpperCase())}</text>`,
  ].join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VERTICAL_FRAME_WIDTH}" height="${VERTICAL_FRAME_HEIGHT}" viewBox="0 0 ${VERTICAL_FRAME_WIDTH} ${VERTICAL_FRAME_HEIGHT}">`,
    box(top, '#ef4444'),
    box(right, '#f59e0b'),
    box(bottom, '#ef4444'),
    '</svg>',
  ].join('');
}
