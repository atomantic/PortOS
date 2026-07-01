/**
 * Inline word-level diff — two stacked rows:
 *   - the OLD text with removed words highlighted in red
 *   - the NEW text with added words highlighted in green
 * Shared component — used by the Cross-Domain Insights narrative diff, the
 * Pipeline text-stage history modal, and the Manuscript editor's edit cards.
 * The LCS/tokenize/cap core lives in `client/src/lib/diffWords.js` (shared with
 * `SideBySideDiff`); this component only renders. Pure / memoized.
 */

import { memo } from 'react';
import { diffWords } from '../../lib/diffWords';
import { renderRuns } from './diffRuns';

const InlineDiff = memo(function InlineDiff({ oldText, newText, emptyLabel = 'No changes.' }) {
  const oldStr = oldText || '';
  const newStr = newText || '';

  if (oldStr === newStr) {
    return (
      <div className="font-mono text-xs p-4 bg-port-bg">
        <div className="text-gray-500">{emptyLabel}</div>
      </div>
    );
  }

  const { tooLarge, oldRuns, newRuns } = diffWords(oldStr, newStr);

  if (tooLarge) {
    return (
      <div className="font-mono text-xs p-4 space-y-2 bg-port-bg">
        <div className="text-gray-500 text-[11px] uppercase tracking-wider">
          Diff too large for inline highlighting — both versions shown in full
        </div>
        <div className="text-port-error leading-relaxed whitespace-pre-wrap">{oldStr}</div>
        <div className="text-port-success leading-relaxed whitespace-pre-wrap">{newStr}</div>
      </div>
    );
  }

  return (
    <div className="font-mono text-xs p-4 space-y-2 bg-port-bg">
      <div className="text-port-error leading-relaxed whitespace-pre-wrap">{renderRuns(oldRuns, false)}</div>
      <div className="text-port-success leading-relaxed whitespace-pre-wrap">{renderRuns(newRuns, true)}</div>
    </div>
  );
});

export default InlineDiff;
