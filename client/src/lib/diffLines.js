/**
 * Line-block diff (Myers LCS over lines) — the structural layer behind the
 * hunked manuscript diffs. Pure / no React.
 *
 *   diffLineBlocks(oldText, newText) → { blocks }
 *   block = { type: 'same', lines } | { type: 'change', oldLines, newLines }
 *
 * Blocks tile both texts in order: joining every same-block's `lines` plus every
 * change-block's `oldLines` with '\n' reproduces the old text verbatim (and
 * `newLines` the new). Renderers collapse the same-blocks to context and run a
 * word-level diff (`diffWords`) inside each change-block — that two-level split
 * is what keeps a several-thousand-word manuscript section diffable: the line
 * LCS is cheap (common prefix/suffix lines are trimmed first), and each
 * word-level pass only sees one small changed region.
 *
 * If even the trimmed middle exceeds the cell cap, it degrades to ONE coarse
 * change block — surrounding context is still preserved, unlike an
 * everything-changed fallback.
 */

import { trimCommonEnds } from './diffWords.js';

export const LINE_DIFF_CELL_CAP = 4_000_000;

// LCS over lines, returning [oldIndex, newIndex] pairs (not values) so
// duplicate lines — blank lines especially — can't be mis-aligned.
function lcsPairs(a, b) {
  const m = a.length, n = b.length;
  const dp = new Int32Array((m + 1) * (n + 1));
  const stride = n + 1;
  for (let i = 1; i <= m; i++) {
    const row = i * stride;
    const prevRow = row - stride;
    for (let j = 1; j <= n; j++) {
      dp[row + j] = a[i - 1] === b[j - 1]
        ? dp[prevRow + j - 1] + 1
        : Math.max(dp[prevRow + j], dp[row + j - 1]);
    }
  }
  const pairs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { pairs.unshift([i - 1, j - 1]); i--; j--; }
    else if (dp[(i - 1) * stride + j] >= dp[i * stride + j - 1]) i--;
    else j--;
  }
  return pairs;
}

export function diffLineBlocks(oldText, newText) {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');

  const { pre, suf, aMid, bMid } = trimCommonEnds(a, b);

  const blocks = [];
  const pushSame = (lines) => {
    if (!lines.length) return;
    const last = blocks[blocks.length - 1];
    if (last?.type === 'same') last.lines = last.lines.concat(lines);
    else blocks.push({ type: 'same', lines });
  };
  const pushChange = (oldLines, newLines) => {
    if (!oldLines.length && !newLines.length) return;
    blocks.push({ type: 'change', oldLines, newLines });
  };

  pushSame(a.slice(0, pre));
  if (aMid.length * bMid.length > LINE_DIFF_CELL_CAP) {
    pushChange(aMid, bMid);
  } else {
    const pairs = lcsPairs(aMid, bMid);
    let pi = 0, pj = 0;
    let sameBuf = [];
    pairs.forEach(([ai, bj]) => {
      if (ai > pi || bj > pj) {
        pushSame(sameBuf);
        sameBuf = [];
        pushChange(aMid.slice(pi, ai), bMid.slice(pj, bj));
      }
      sameBuf.push(aMid[ai]);
      pi = ai + 1;
      pj = bj + 1;
    });
    pushSame(sameBuf);
    pushChange(aMid.slice(pi), bMid.slice(pj));
  }
  pushSame(suf ? a.slice(a.length - suf) : []);
  return { blocks };
}
