/**
 * Inline word-level diff using Myers LCS. Renders two stacked rows:
 *   - the OLD text with removed words highlighted in red
 *   - the NEW text with added words highlighted in green
 * Shared component — used by the Cross-Domain Insights narrative diff and the
 * Pipeline text-stage history modal. Pure / memoized / no external deps.
 */

import { memo } from 'react';

function lcs(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const seq = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { seq.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return seq;
}

// LCS allocates an (m+1)×(n+1) DP table; the product — not each side — is
// what matters. Cap at ~4M cells (~16MB at 4 bytes/cell, well inside browser
// memory for a per-modal computation). A 2000×2000 diff stays in budget;
// a 4000×4000 (real-world comic script vs full rewrite) bails to the
// side-by-side fallback below.
const DIFF_CELL_CAP = 4_000_000;

const InlineDiff = memo(function InlineDiff({ oldText, newText, emptyLabel = 'No changes.' }) {
  const oldStr = oldText || '';
  const newStr = newText || '';
  const oldWords = oldStr.split(/(\s+)/);
  const newWords = newStr.split(/(\s+)/);

  if (oldStr === newStr) {
    return (
      <div className="font-mono text-xs p-4 bg-port-bg">
        <div className="text-gray-500">{emptyLabel}</div>
      </div>
    );
  }
  if (oldWords.length * newWords.length > DIFF_CELL_CAP) {
    return (
      <div className="font-mono text-xs p-4 space-y-2 bg-port-bg">
        <div className="text-gray-500 text-[11px] uppercase tracking-wider">
          Diff too large for inline highlighting — both versions shown in full
        </div>
        <div className="text-red-400 leading-relaxed whitespace-pre-wrap">{oldStr}</div>
        <div className="text-green-400 leading-relaxed whitespace-pre-wrap">{newStr}</div>
      </div>
    );
  }
  const commonSeq = lcs(oldWords, newWords);

  const render = (words, added) => {
    const spans = [];
    let run = [];
    let ci = 0;
    words.forEach((w, i) => {
      if (ci < commonSeq.length && w === commonSeq[ci]) {
        ci++;
        if (run.length) {
          spans.push(
            <span key={`${i}r`} className={added ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}>
              {run.join('')}
            </span>,
          );
          run = [];
        }
        spans.push(w);
      } else {
        run.push(w);
      }
    });
    if (run.length) {
      spans.push(
        <span key="last" className={added ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}>
          {run.join('')}
        </span>,
      );
    }
    return spans;
  };

  return (
    <div className="font-mono text-xs p-4 space-y-2 bg-port-bg">
      <div className="text-red-400 leading-relaxed whitespace-pre-wrap">{render(oldWords, false)}</div>
      <div className="text-green-400 leading-relaxed whitespace-pre-wrap">{render(newWords, true)}</div>
    </div>
  );
});

export default InlineDiff;
