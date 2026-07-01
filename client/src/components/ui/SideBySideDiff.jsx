/**
 * Columnar word-level diff — OLD on the left (removed words red), NEW on the
 * right (added words green), so an edit reads as a before/after comparison.
 * Companion to the stacked `InlineDiff`; both share the LCS/tokenize/cap core in
 * `client/src/lib/diffWords.js`. Pure / memoized.
 *
 * Each column flows independently (whitespace-pre-wrap) rather than aligning
 * line-for-line — alignment of arbitrary prose rewrites is ambiguous, and the
 * red/green run highlighting already shows what changed within each side.
 */

import { memo } from 'react';
import { diffWords } from '../../lib/diffWords';
import { renderRuns } from './diffRuns';

const Column = ({ label, children }) => (
  <div className="min-w-0 flex-1">
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
    <div className="leading-relaxed whitespace-pre-wrap break-words">{children}</div>
  </div>
);

const SideBySideDiff = memo(function SideBySideDiff({
  oldText, newText, oldLabel = 'Before', newLabel = 'After', emptyLabel = 'No changes.',
}) {
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
          Diff too large for word highlighting — both versions shown in full
        </div>
        <div className="flex gap-4">
          <Column label={oldLabel}><span className="text-port-error">{oldStr}</span></Column>
          <Column label={newLabel}><span className="text-port-success">{newStr}</span></Column>
        </div>
      </div>
    );
  }

  return (
    <div className="font-mono text-xs p-4 bg-port-bg">
      <div className="flex gap-4">
        <Column label={oldLabel}><span className="text-port-error">{renderRuns(oldRuns, false)}</span></Column>
        <Column label={newLabel}><span className="text-port-success">{renderRuns(newRuns, true)}</span></Column>
      </div>
    </div>
  );
});

export default SideBySideDiff;
