/**
 * Word-level diff core (Myers LCS) — the shared computation behind both the
 * stacked `InlineDiff` and the columnar `SideBySideDiff`. Pure / no React.
 *
 * `diffWords(oldText, newText)` tokenizes each side on whitespace (each word and
 * its trailing whitespace is its own token), finds the longest common
 * subsequence, and returns the two sides already collapsed into renderable runs:
 *
 *   { tooLarge, oldRuns, newRuns }
 *   run = { text, changed }   // changed=true ⇒ removed (old) / added (new)
 *
 * `tooLarge` guards the (m+1)×(n+1) DP allocation. The product — not either
 * side — is what matters; cap at 4M cells (~16MB Int32Array). Common
 * prefix/suffix tokens are trimmed before sizing the table, so a localized edit
 * inside an arbitrarily long text stays under the cap — only texts whose
 * *differing middle* exceeds ~1000×1000 words trip it. Past it, callers fall
 * back to showing both versions in full rather than risk a freeze.
 */

export const DIFF_CELL_CAP = 4_000_000;

// Trim the common prefix/suffix off two token arrays so only the differing
// middle pays for LCS. Shared with the line-level `diffLines.js`.
export function trimCommonEnds(a, b) {
  let pre = 0;
  const maxPre = Math.min(a.length, b.length);
  while (pre < maxPre && a[pre] === b[pre]) pre++;
  let suf = 0;
  const maxSuf = maxPre - pre;
  while (suf < maxSuf && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf, aMid: a.slice(pre, a.length - suf), bMid: b.slice(pre, b.length - suf) };
}

function lcs(a, b) {
  const m = a.length, n = b.length;
  // Single Int32Array — exactly 4 bytes/cell, no per-element boxing the way a
  // nested JS Array would. Indexed as dp[i*(n+1)+j] to keep the (m+1)×(n+1)
  // shape backtracking expects.
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
  const seq = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { seq.unshift(a[i - 1]); i--; j--; }
    else if (dp[(i - 1) * stride + j] >= dp[i * stride + j - 1]) i--;
    else j--;
  }
  return seq;
}

// Collapse a token list into runs, marking tokens absent from the common
// subsequence as changed and merging consecutive same-state tokens into one run.
function toRuns(words, commonSeq) {
  const runs = [];
  let buf = '';
  let bufChanged = null;
  let ci = 0;
  const flush = () => {
    if (buf) runs.push({ text: buf, changed: bufChanged });
    buf = '';
    bufChanged = null;
  };
  words.forEach((w) => {
    const common = ci < commonSeq.length && w === commonSeq[ci];
    if (common) ci++;
    const changed = !common;
    if (bufChanged !== null && bufChanged !== changed) flush();
    buf += w;
    bufChanged = changed;
  });
  flush();
  return runs;
}

// Glue an unchanged prefix/suffix run back onto a run list, merging with an
// adjacent unchanged run so consecutive same-state runs stay collapsed.
function wrapRuns(prefix, runs, suffix) {
  const out = runs.filter((r) => r.text);
  if (prefix) {
    if (out[0] && !out[0].changed) out[0] = { text: prefix + out[0].text, changed: false };
    else out.unshift({ text: prefix, changed: false });
  }
  if (suffix) {
    const last = out[out.length - 1];
    if (last && !last.changed) out[out.length - 1] = { text: last.text + suffix, changed: false };
    else out.push({ text: suffix, changed: false });
  }
  return out;
}

export function diffWords(oldText, newText) {
  const oldStr = oldText || '';
  const newStr = newText || '';
  const oldWords = oldStr.split(/(\s+)/);
  const newWords = newStr.split(/(\s+)/);

  const { pre, suf, aMid: oldMid, bMid: newMid } = trimCommonEnds(oldWords, newWords);

  if (oldMid.length * newMid.length > DIFF_CELL_CAP) {
    return {
      tooLarge: true,
      oldRuns: oldStr ? [{ text: oldStr, changed: true }] : [],
      newRuns: newStr ? [{ text: newStr, changed: true }] : [],
    };
  }

  const commonSeq = lcs(oldMid, newMid);
  const prefix = oldWords.slice(0, pre).join('');
  const suffix = suf ? oldWords.slice(oldWords.length - suf).join('') : '';
  return {
    tooLarge: false,
    oldRuns: wrapRuns(prefix, toRuns(oldMid, commonSeq), suffix),
    newRuns: wrapRuns(prefix, toRuns(newMid, commonSeq), suffix),
  };
}
