/**
 * Shot color match for a music video, before the film look.
 *
 * Shots rendered one at a time drift in exposure and white balance even inside
 * one scene on one camera. This measures each take and solves a small
 * per-pixel correction (black, white, gamma, white balance, saturation). The
 * numbers stay on the take; the picture file is unchanged until a render
 * applies them. Turning the match off, or setting its strength to zero, is no
 * correction at all, so the previous render stays the one on disk.
 *
 * Browser-safe: no file, ffmpeg, or sharp imports. The render and the animatic
 * both consume `activeShotColorMatch`.
 */

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
const EPS = 1e-4;
const LEVEL_FLOOR = 0.02;

export const COLOR_MATCH_IDENTITY = Object.freeze({
  black: 0, white: 1, gamma: 1, balanceR: 1, balanceB: 1, saturation: 1,
});

// Modest on purpose: a render past these is a re-roll, not a correction to force.
export const COLOR_MATCH_LIMITS = Object.freeze({
  black: [-0.12, 0.12],
  white: [0.7, 1.45],
  gamma: [0.75, 1.35],
  balanceR: [0.82, 1.22],
  balanceB: [0.82, 1.22],
  saturation: [0.7, 1.4],
});

const CORRECTION_KEYS = Object.keys(COLOR_MATCH_IDENTITY);
const FLASH_EFFECTS = new Set(['flash-develop', 'end-flash']);

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

function normText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function rgbFromStats(stats) {
  const y = stats.lumaMean;
  const r = y + stats.chromaV;
  const b = y + stats.chromaU;
  const g = (y - LUMA_R * r - LUMA_B * b) / LUMA_G;
  return { r, g, b, y };
}

function clampCorrection(raw) {
  const correction = {};
  let outlier = false;
  for (const key of CORRECTION_KEYS) {
    const [lo, hi] = COLOR_MATCH_LIMITS[key];
    const n = Number(raw[key]);
    const finite = Number.isFinite(n) ? n : COLOR_MATCH_IDENTITY[key];
    const clamped = Math.min(hi, Math.max(lo, finite));
    if (Math.abs(clamped - finite) > EPS) outlier = true;
    correction[key] = round6(clamped);
  }
  return { correction, outlier };
}

/** A camera marked do-not-match, or a flash still, is not matched to its neighbors. */
export function shotSkipsColorMatch(scene, camera) {
  if (camera?.doNotMatch) return true;
  return FLASH_EFFECTS.has(scene?.imageEffect);
}

/**
 * The group a shot belongs to: one camera, one location, one time of day.
 * Spelling differs only by case or surrounding space still group. A shot
 * missing any of the three, or one `shotSkipsColorMatch` skips, has no group,
 * so the time-of-day change from one group to the next is left alone.
 */
export function colorMatchGroupOf(scene, cameras = []) {
  const camera = cameras.find((entry) => entry?.id && entry.id === scene?.shotSheet?.cameraId) || null;
  if (!scene || shotSkipsColorMatch(scene, camera)) return null;
  const cameraId = scene.shotSheet?.cameraId;
  const locationKey = normText(scene.shotSheet?.location);
  const timeKey = normText(scene.shotSheet?.timeOfDay);
  if (!cameraId || !locationKey || !timeKey) return null;
  return {
    cameraId,
    location: scene.shotSheet.location.trim(),
    timeOfDay: scene.shotSheet.timeOfDay.trim(),
    locationKey,
    timeKey,
    key: `${cameraId}\n${locationKey}\n${timeKey}`,
    camera,
  };
}

/** The take whose picture is on screen: the still when the shot has no clip, else the clip. */
export function selectedColorMatchTake(scene) {
  const takes = Array.isArray(scene?.takes) ? scene.takes : [];
  const still = scene?.visualLayer === 'still' || !scene?.videoHistoryId;
  if (still) {
    if (!scene?.referenceImageId) return null;
    return takes.find((take) => take?.kind === 'image' && take.assetId === scene.referenceImageId) || null;
  }
  return takes.find((take) => take?.kind === 'video' && take.assetId === scene.videoHistoryId) || null;
}

/** Luma percentiles and mean chroma of an RGB buffer. `channels` is 3 or 4. */
export function measureRgbStats(data, width, height, channels = 3) {
  const count = width * height;
  if (!count || !data || data.length < count * channels) return null;
  const lumas = new Float64Array(count);
  let sumY = 0;
  let sumU = 0;
  let sumV = 0;
  for (let i = 0; i < count; i += 1) {
    const offset = i * channels;
    const r = data[offset] / 255;
    const g = data[offset + 1] / 255;
    const b = data[offset + 2] / 255;
    const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    lumas[i] = y;
    sumY += y;
    sumU += b - y;
    sumV += r - y;
  }
  lumas.sort();
  const at = (q) => lumas[Math.min(count - 1, Math.max(0, Math.round((count - 1) * q)))];
  return {
    lumaP5: at(0.05),
    lumaP50: at(0.5),
    lumaP95: at(0.95),
    lumaMean: sumY / count,
    chromaU: sumU / count,
    chromaV: sumV / count,
  };
}

const STAT_KEYS = ['lumaP5', 'lumaP50', 'lumaP95', 'lumaMean', 'chromaU', 'chromaV'];

export function averageColorStats(list) {
  const usable = (list || []).filter(Boolean);
  if (!usable.length) return null;
  const out = {};
  for (const key of STAT_KEYS) out[key] = usable.reduce((sum, stats) => sum + stats[key], 0) / usable.length;
  return out;
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianColorStats(list) {
  const usable = (list || []).filter(Boolean);
  if (!usable.length) return null;
  const out = {};
  for (const key of STAT_KEYS) out[key] = medianOf(usable.map((stats) => stats[key]));
  return out;
}

/**
 * The correction that takes `source` toward `reference`.
 * White balance first (green-normalized ratios), then black, white and gamma
 * on the luma percentiles. Saturation stays unchanged because mean chroma
 * cannot separate a color cast from color variation. Each parameter is clamped; a value
 * the clamp had to move is an outlier, so a bad render is flagged rather than forced.
 */
// Leading underscore: the render calls solveProjectColorMatch and the filters.
// These stay exported so the tolerance tests can pin the curve itself.
export function _solveColorMatch(source, reference) {
  const srcRgb = rgbFromStats(source);
  const refRgb = rgbFromStats(reference);
  let balanceR = 1;
  let balanceB = 1;
  const channelsLit = [srcRgb.r, srcRgb.g, srcRgb.b, refRgb.r, refRgb.g, refRgb.b].every((n) => n > LEVEL_FLOOR);
  if (channelsLit) {
    balanceR = (refRgb.r / refRgb.g) / (srcRgb.r / srcRgb.g);
    balanceB = (refRgb.b / refRgb.g) / (srcRgb.b / srcRgb.g);
  }
  const balancedY = LUMA_R * srcRgb.r * balanceR + LUMA_G * srcRgb.g + LUMA_B * srcRgb.b * balanceB;
  const wbScale = balancedY / Math.max(srcRgb.y, 1e-4);
  const adj = (p) => p * wbScale;
  const adjSpan = adj(source.lumaP95) - adj(source.lumaP5);
  const refSpan = reference.lumaP95 - reference.lumaP5;
  let white = 1;
  let black = 0;
  let gamma = 1;
  if (adjSpan >= LEVEL_FLOOR && refSpan >= LEVEL_FLOOR) {
    white = refSpan / adjSpan;
    black = reference.lumaP5 - white * adj(source.lumaP5);
    const mapped = clamp01(adj(source.lumaP50) * white + black);
    const base = Math.min(1 - 1e-3, Math.max(1e-3, mapped));
    const target = Math.min(1 - 1e-3, Math.max(1e-3, reference.lumaP50));
    if (base > LEVEL_FLOOR && base < 1 - LEVEL_FLOOR) gamma = Math.log(target) / Math.log(base);
  } else {
    white = reference.lumaMean / Math.max(balancedY, 1e-4);
  }
  // Mean chroma measures a color cast, not color variation. White balance
  // already corrects that cast; these statistics cannot justify desaturation.
  return clampCorrection({ black, white, gamma, balanceR, balanceB, saturation: 1 });
}

/** The correction a render applies, or null when matching is off, at zero strength, or already identity. */
export function _effectiveColorMatch(stored) {
  if (!stored || stored.enabled === false || !stored.correction) return null;
  const strength = Number.isFinite(stored.strength) ? stored.strength : 1;
  if (!(strength > 0)) return null;
  const out = {};
  for (const key of CORRECTION_KEYS) {
    const value = Number(stored.correction[key]);
    const solved = Number.isFinite(value) ? value : COLOR_MATCH_IDENTITY[key];
    out[key] = round6(COLOR_MATCH_IDENTITY[key] + (solved - COLOR_MATCH_IDENTITY[key]) * strength);
  }
  return CORRECTION_KEYS.every((key) => Math.abs(out[key] - COLOR_MATCH_IDENTITY[key]) <= EPS) ? null : out;
}

/** The selected take's correction, or null when this shot is skipped or unmatched. */
export function activeShotColorMatch(project, scene) {
  if (!scene) return null;
  const camera = (project?.cameras || []).find((entry) => entry?.id === scene.shotSheet?.cameraId) || null;
  if (shotSkipsColorMatch(scene, camera)) return null;
  return _effectiveColorMatch(selectedColorMatchTake(scene)?.colorMatch);
}

/** One pixel, 0–1 in and out. The same curve as `colorMatchVideoFilter`. */
export function _applyColorMatchPixel(r, g, b, correction) {
  const curve = (x, balance) => {
    const lifted = x * balance * correction.white + correction.black;
    return clamp01(lifted) ** correction.gamma;
  };
  const red = curve(r, correction.balanceR);
  const green = curve(g, 1);
  const blue = curve(b, correction.balanceB);
  const y = LUMA_R * red + LUMA_G * green + LUMA_B * blue;
  const sat = correction.saturation;
  const mix = (channel) => clamp01(y + (channel - y) * sat);
  return [mix(red), mix(green), mix(blue)];
}

/** A copy of `data` with the correction applied. The input buffer is left as it was. */
export function _applyColorMatchBuffer(data, width, height, correction, channels = 3) {
  const out = new Uint8ClampedArray(data.length);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const offset = i * channels;
    const [r, g, b] = _applyColorMatchPixel(data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255, correction);
    out[offset] = Math.round(r * 255);
    out[offset + 1] = Math.round(g * 255);
    out[offset + 2] = Math.round(b * 255);
    if (channels === 4) out[offset + 3] = data[offset + 3];
  }
  return out;
}

const fmt = (n) => Number(n).toFixed(6);

/**
 * The ffmpeg filter for one correction, or null when there is nothing to do.
 * `geq` repeats the pixel curve because each channel expression sees only the
 * input pixel. Commas inside an expression are escaped so they are not filter
 * separators. A null return means the caller inserts no filter.
 */
export function colorMatchVideoFilter(correction) {
  if (!correction) return null;
  const curve = (channel, balance) => `pow(clip(${channel}/255*${fmt(balance)}*${fmt(correction.white)}+${fmt(correction.black)}\\,0\\,1)\\,${fmt(correction.gamma)})`;
  const red = curve('r(X\\,Y)', correction.balanceR);
  const green = curve('g(X\\,Y)', 1);
  const blue = curve('b(X\\,Y)', correction.balanceB);
  const y = `(${LUMA_R}*(${red})+${LUMA_G}*(${green})+${LUMA_B}*(${blue}))`;
  const sat = fmt(correction.saturation);
  const chan = (curved) => `clip((${y}+((${curved})-${y})*${sat})*255\\,0\\,255)`;
  return `format=rgb24,geq=r='${chan(red)}':g='${chan(green)}':b='${chan(blue)}',format=yuv420p`;
}

/** SVG filter matrices for the animatic. The same curve, clamped between primitives. */
export function colorMatchSvgParts(correction) {
  const { balanceR, balanceB, white, black, gamma, saturation } = correction;
  const keep = 1 - saturation;
  const luma = { r: LUMA_R, g: LUMA_G, b: LUMA_B };
  // R' = sat*R + (1-sat)*Y, and the same for G and B.
  const row = (own) => {
    const cell = (channel) => keep * luma[channel] + (channel === own ? saturation : 0);
    return [cell('r'), cell('g'), cell('b'), 0, 0];
  };
  return {
    balance: [
      balanceR * white, 0, 0, 0, black,
      0, white, 0, 0, black,
      0, 0, balanceB * white, 0, black,
      0, 0, 0, 1, 0,
    ].map((n) => round6(n)).join(' '),
    gamma,
    saturate: [...row('r'), ...row('g'), ...row('b'), 0, 0, 0, 1, 0].map((n) => round6(n)).join(' '),
  };
}

/** The SVG filter element markup for one correction's parts (test hook). */
export function _colorMatchFilterMarkup(parts, id = 'portos-color-match') {
  if (!parts) return '';
  return `<filter id="${id}" color-interpolation-filters="sRGB">`
    + `<feColorMatrix type="matrix" values="${parts.balance}"/>`
    + `<feComponentTransfer>`
    + `<feFuncR type="gamma" amplitude="1" exponent="${parts.gamma}" offset="0"/>`
    + `<feFuncG type="gamma" amplitude="1" exponent="${parts.gamma}" offset="0"/>`
    + `<feFuncB type="gamma" amplitude="1" exponent="${parts.gamma}" offset="0"/>`
    + `</feComponentTransfer>`
    + `<feColorMatrix type="matrix" values="${parts.saturate}"/>`
    + `</filter>`;
}

/** True when at least one shot in the project has an active color match correction. */
export function hasMusicVideoColorMatch(project) {
  return (project?.scenes || []).some((scene) => activeShotColorMatch(project, scene) != null);
}

/** Active color-match entries for scenes in the project (test hook). */
export function _projectColorMatchEntries(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const entries = [];
  for (const scene of scenes) {
    if (!scene?.sceneId) continue;
    const correction = activeShotColorMatch(project, scene);
    if (!correction) continue;
    const parts = colorMatchSvgParts(correction);
    const filterId = `portos-color-match-${String(scene.sceneId).replace(/[^A-Za-z0-9_-]/g, '')}`;
    entries.push({ sceneId: scene.sceneId, filterId, correction, parts });
  }
  return entries;
}

/**
 * Page runtime source for document preview and render: creates SVG filter definitions
 * for matched shots and exposes globalThis.__portosColorMatch.
 * Matching off inserts no filter.
 */
export function documentShotColorMatchRuntime(project) {
  const entries = _projectColorMatchEntries(project);
  if (!entries.length) return '';
  const json = (val) => JSON.stringify(val).replace(/</g, '\\u003c');
  return `(() => {
  const entries = ${json(entries.map(({ sceneId, filterId, parts }) => ({ sceneId, filterId, parts })))};
  const byId = new Map(entries.map((e) => [e.sceneId, e]));
  const buildFilter = (filterId, parts) => {
    return '<filter id="' + filterId + '" color-interpolation-filters="sRGB">'
      + '<feColorMatrix type="matrix" values="' + parts.balance + '"/>'
      + '<feComponentTransfer>'
      + '<feFuncR type="gamma" amplitude="1" exponent="' + parts.gamma + '" offset="0"/>'
      + '<feFuncG type="gamma" amplitude="1" exponent="' + parts.gamma + '" offset="0"/>'
      + '<feFuncB type="gamma" amplitude="1" exponent="' + parts.gamma + '" offset="0"/>'
      + '</feComponentTransfer>'
      + '<feColorMatrix type="matrix" values="' + parts.saturate + '"/>'
      + '</filter>';
  };
  let host = null;
  const mount = () => {
    const root = document.body || document.documentElement;
    if (!root) return;
    if (!host) {
      host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      host.setAttribute('width', '0');
      host.setAttribute('height', '0');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      host.dataset.portosColorMatch = '1';
    }
    if (!host.isConnected) root.appendChild(host);
    host.innerHTML = '<defs>' + entries.map((e) => buildFilter(e.filterId, e.parts)).join('') + '</defs>';
  };
  const api = {
    filterId(sceneId) {
      const e = byId.get(sceneId);
      return e ? e.filterId : null;
    },
    filterCss(sceneId) {
      const e = byId.get(sceneId);
      return e ? 'url(#' + e.filterId + ')' : null;
    },
    parts(sceneId) {
      const e = byId.get(sceneId);
      return e ? e.parts : null;
    },
  };
  Object.defineProperty(globalThis, '__portosColorMatch', { value: api, configurable: true, writable: true });
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();`;
}

function statsOf(take, measurements) {
  if (!take?.takeId) return null;
  return measurements?.[take.takeId] || take.colorMatch?.stats || null;
}

function sameGroup(reference, group) {
  return reference?.cameraId === group.cameraId
    && normText(reference.location) === group.locationKey
    && normText(reference.timeOfDay) === group.timeKey;
}

/**
 * Write measured stats onto takes and solve each group's corrections.
 * `measurements` is `{ [takeId]: stats }` for takes just measured; other takes
 * keep stored stats. A take marked `edited` keeps its numbers. The reference
 * shot's selected take is identity. Does not mutate `project`.
 */
export function solveProjectColorMatch(project, measurements = {}, measuredAt = null) {
  const scenes = (project?.scenes || []).map((scene) => ({
    ...scene,
    takes: (scene.takes || []).map((take) => ({ ...take })),
  }));
  const cameras = project?.cameras || [];
  const groups = new Map();
  for (const scene of scenes) {
    const group = colorMatchGroupOf(scene, cameras);
    if (!group) continue;
    if (!groups.has(group.key)) groups.set(group.key, { ...group, scenes: [] });
    groups.get(group.key).scenes.push(scene);
  }
  const references = project?.colorMatch?.references || [];
  for (const group of groups.values()) {
    const picked = references.find((reference) => sameGroup(reference, group));
    const pickedScene = picked ? group.scenes.find((scene) => scene.sceneId === picked.sceneId) : null;
    const selectedStats = (scene) => statsOf(selectedColorMatchTake(scene), measurements);
    let referenceStats = pickedScene ? selectedStats(pickedScene) : null;
    const referenceIsPick = !!referenceStats;
    if (!referenceStats) {
      referenceStats = medianColorStats(group.scenes.map(selectedStats));
    }
    if (!referenceStats) continue;
    for (const scene of group.scenes) {
      const selected = selectedColorMatchTake(scene);
      scene.takes = (scene.takes || []).map((take) => {
        const fresh = measurements?.[take.takeId] || null;
        const stats = fresh || take.colorMatch?.stats || null;
        if (!stats) return take;
        const isReference = referenceIsPick && pickedScene?.sceneId === scene.sceneId && selected?.takeId === take.takeId;
        let correction;
        let outlier = false;
        let edited = take.colorMatch?.edited === true;
        if (isReference) {
          correction = { ...COLOR_MATCH_IDENTITY };
          edited = false;
        } else if (edited && take.colorMatch?.correction) {
          correction = { ...take.colorMatch.correction };
          outlier = false;
        } else {
          const solved = _solveColorMatch(stats, referenceStats);
          correction = solved.correction;
          outlier = solved.outlier;
        }
        const next = {
          enabled: take.colorMatch?.enabled !== false,
          strength: Number.isFinite(take.colorMatch?.strength) ? take.colorMatch.strength : 1,
          stats,
          correction,
          outlier,
          measuredAt: fresh ? measuredAt : (take.colorMatch?.measuredAt || measuredAt),
        };
        if (edited) next.edited = true;
        return { ...take, colorMatch: next };
      });
    }
  }
  return { scenes, colorMatch: project?.colorMatch || null };
}

function predictedLuma(stats, correction) {
  if (!correction) return stats.lumaP50;
  const [r, g, b] = _applyColorMatchPixel(stats.lumaP50, stats.lumaP50, stats.lumaP50, correction);
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

function predictedChroma(stats, correction) {
  const { r, g, b } = rgbFromStats(stats);
  const [rr, gg, bb] = correction ? _applyColorMatchPixel(r, g, b, correction) : [r, g, b];
  const y = LUMA_R * rr + LUMA_G * gg + LUMA_B * bb;
  return { u: bb - y, v: rr - y };
}

function spread(values) {
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}

/** Groups for the board: spread of the selected takes before and after the stored corrections. */
export function colorMatchGroups(project) {
  const cameras = project?.cameras || [];
  const groups = new Map();
  for (const scene of project?.scenes || []) {
    const group = colorMatchGroupOf(scene, cameras);
    if (!group) continue;
    if (!groups.has(group.key)) groups.set(group.key, { ...group, scenes: [] });
    groups.get(group.key).scenes.push(scene);
  }
  const references = project?.colorMatch?.references || [];
  return [...groups.values()].map((group) => {
    const picked = references.find((reference) => sameGroup(reference, group)) || null;
    const rows = group.scenes.map((scene) => {
      const take = selectedColorMatchTake(scene);
      const stats = take?.colorMatch?.stats || null;
      const correction = _effectiveColorMatch(take?.colorMatch);
      return { scene, take, stats, correction, outlier: take?.colorMatch?.outlier === true };
    }).filter((row) => row.stats);
    const beforeLuma = rows.map((row) => row.stats.lumaP50);
    const afterLuma = rows.map((row) => predictedLuma(row.stats, row.correction));
    const beforeChroma = rows.map((row) => predictedChroma(row.stats, null));
    const afterChroma = rows.map((row) => predictedChroma(row.stats, row.correction));
    const chromaSpread = (points) => {
      if (points.length < 2) return 0;
      const midU = medianOf(points.map((point) => point.u));
      const midV = medianOf(points.map((point) => point.v));
      return Math.max(...points.map((point) => Math.hypot(point.u - midU, point.v - midV)));
    };
    return {
      key: group.key,
      cameraId: group.cameraId,
      cameraName: group.camera?.name || 'Camera',
      location: group.location,
      timeOfDay: group.timeOfDay,
      referenceSceneId: picked?.sceneId || null,
      lumaSpreadBefore: spread(beforeLuma),
      lumaSpreadAfter: spread(afterLuma),
      chromaSpreadBefore: chromaSpread(beforeChroma),
      chromaSpreadAfter: chromaSpread(afterChroma),
      shots: group.scenes.map((scene) => {
        const row = rows.find((entry) => entry.scene === scene);
        return {
          sceneId: scene.sceneId,
          label: scene.label || 'Shot',
          outlier: row?.outlier === true,
          measured: !!row,
        };
      }),
    };
  });
}

/**
 * The film-look cache payload. `match` is present only when a correction is
 * active, so a segment with matching off hashes to the same bytes as before
 * color match existed.
 */
export function segmentLookHashPayload({ version, baseKey, look, startSec, fps, matchKey = null }) {
  return { v: version, baseKey, look, startSec, fps, ...(matchKey ? { match: matchKey } : {}) };
}

/** Cache file name for a segment. No match and no look keeps the base name. */
export function segmentCacheName({ baseKey, lookKey = null, matchKey = null, prefix = '' }) {
  const stem = `${prefix}${baseKey}`;
  if (lookKey) return `${stem}-${lookKey}.mp4`;
  if (matchKey) return `${stem}-match-${matchKey}.mp4`;
  return `${stem}.mp4`;
}
