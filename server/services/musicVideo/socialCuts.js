/**
 * Music Video — hook windows for vertical social cuts (#9280).
 *
 * A Short / TikTok / Reel lives or dies in its first seconds, so a cut should
 * open on a sung line, hold a face that is singing it, sit in the song's
 * loudest stretch, and ideally say the title. This scores every lyric-line
 * aligned window of `minSec`–`maxSec` on those signals and returns the best
 * non-overlapping few. Pure: project in, suggestions out.
 */

const round3 = (n) => Math.round(n * 1000) / 1000;
const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const HOOK_SECTION = /\b(chorus|hook|refrain|drop)\b/i;
const LIFT_SECTION = /\b(bridge|breakdown|pre-?chorus)\b/i;
const LEAD_IN_SEC = 0.25;
const TAIL_SEC = 0.35;
const WEIGHTS = Object.freeze({ performance: 0.35, lyric: 0.2, energy: 0.2, hook: 0.15, title: 0.1 });

function songLength(project) {
  const ends = [finite(project?.audioAnalysis?.durationSec)];
  for (const s of project?.scenes || []) ends.push(finite(s?.endSec));
  for (const c of project?.lyricCues || []) ends.push(finite(c?.endSec));
  return ends.reduce((max, v) => (v != null && v > max ? v : max), 0);
}

function lyricLines(project) {
  return (project?.lyricCues || [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim() && finite(c.startSec) != null)
    .map((c) => ({ text: c.text.trim(), startSec: c.startSec, endSec: finite(c.endSec) != null && c.endSec > c.startSec ? c.endSec : c.startSec + 1.5 }))
    .sort((a, b) => a.startSec - b.startSec);
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const covered = (spans, s, e) => spans.reduce((sum, span) => sum + overlap(s, e, span.startSec, span.endSec), 0) / (e - s);

const normalize = (text) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function titlePhrase(project) {
  const name = typeof project?.name === 'string' ? normalize(project.name.replace(/\(.*?\)|\[.*?\]/g, '')) : '';
  return name.length >= 3 ? name : null;
}

/** Mean waveform level over [s, e), relative to the song's loudest stretch of the same length. */
function energyScorer(project, duration) {
  const wave = Array.isArray(project?.audioAnalysis?.waveform) ? project.audioAnalysis.waveform.filter((v) => finite(v) != null) : [];
  if (wave.length < 8 || !(duration > 0)) return () => 0.5;
  const at = (s, e) => {
    const i0 = Math.max(0, Math.floor((s / duration) * wave.length));
    const i1 = Math.min(wave.length, Math.max(i0 + 1, Math.ceil((e / duration) * wave.length)));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += wave[i];
    return sum / (i1 - i0);
  };
  const peak = Math.max(...wave);
  return (s, e) => (peak > 0 ? Math.min(1, at(s, e) / peak) : 0.5);
}

function scoreWindow(ctx, startSec, endSec) {
  const { performance, lines, hookSpans, liftSpans, title, energy } = ctx;
  const perf = covered(performance, startSec, endSec);
  const lyric = Math.min(1, covered(lines, startSec, endSec));
  const loud = energy(startSec, endSec);
  const hook = covered(hookSpans, startSec, endSec) > 0.5 ? 1 : covered(liftSpans, startSec, endSec) > 0.5 ? 0.5 : 0;
  const inside = lines.filter((l) => l.startSec >= startSec - 1e-6 && l.startSec < endSec);
  const saysTitle = title && inside.some((l) => normalize(l.text).includes(title)) ? 1 : 0;
  const score = WEIGHTS.performance * perf + WEIGHTS.lyric * lyric + WEIGHTS.energy * loud + WEIGHTS.hook * hook + WEIGHTS.title * saysTitle;
  const reasons = [];
  if (perf >= 0.5) reasons.push(`lip-sync ${Math.round(perf * 100)}%`);
  if (hook === 1) reasons.push('chorus');
  else if (hook === 0.5) reasons.push('bridge');
  if (saysTitle) reasons.push('sings the title');
  if (loud >= 0.75) reasons.push('high energy');
  return { score, reasons, label: inside[0]?.text?.slice(0, 80) || null };
}

/**
 * Up to `count` non-overlapping `{ startSec, endSec, score, label, reasons }`
 * windows, best first. Windows open just before a sung line and close just after
 * one; a song without lyric timing falls back to evenly spaced windows.
 */
export function suggestSocialCuts(project, { count = 3, minSec = 15, maxSec = 30 } = {}) {
  const duration = songLength(project);
  if (!(duration > 0)) return [];
  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  if (duration <= lo) return [{ startSec: 0, endSec: round3(duration), score: 1, label: null, reasons: ['whole song'] }];
  const scenes = (project?.scenes || []).filter((s) => finite(s?.startSec) != null && finite(s?.endSec) != null && s.endSec > s.startSec);
  const ctx = {
    lines: lyricLines(project),
    performance: scenes.filter((s) => s.shotMode === 'performance'),
    hookSpans: scenes.filter((s) => HOOK_SECTION.test(s.sectionLabel || '')),
    liftSpans: scenes.filter((s) => LIFT_SECTION.test(s.sectionLabel || '')),
    title: titlePhrase(project),
    energy: energyScorer(project, duration),
  };
  const candidates = [];
  if (ctx.lines.length) {
    for (const first of ctx.lines) {
      const startSec = Math.max(0, first.startSec - LEAD_IN_SEC);
      let best = null;
      for (const last of ctx.lines) {
        const endSec = Math.min(duration, last.endSec + TAIL_SEC);
        const span = endSec - startSec;
        if (last.startSec < first.startSec || span < lo || span > hi) continue;
        const scored = scoreWindow(ctx, startSec, endSec);
        if (!best || scored.score > best.score + 1e-9) best = { startSec, endSec, ...scored };
      }
      if (best) candidates.push(best);
    }
  }
  if (!candidates.length) {
    const span = Math.min(hi, duration);
    for (let startSec = 0; startSec + span <= duration + 1e-6; startSec += Math.max(1, span / 2)) {
      candidates.push({ startSec, endSec: startSec + span, ...scoreWindow(ctx, startSec, startSec + span) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.startSec - b.startSec);
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (picked.some((p) => overlap(p.startSec, p.endSec, c.startSec, c.endSec) > 0)) continue;
    picked.push(c);
  }
  return picked.map((c) => ({ startSec: round3(c.startSec), endSec: round3(c.endSec), score: round3(c.score), label: c.label, reasons: c.reasons }));
}
