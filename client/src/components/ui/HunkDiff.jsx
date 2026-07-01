/**
 * Hunked side-by-side diff for long texts — line-level blocks from
 * `diffLineBlocks`, with unchanged runs collapsed to "⋯ N unchanged lines"
 * (keeping a couple of context lines around each change) and each changed block
 * rendered as word-highlighted before/after columns. Built for the manuscript
 * impact preview, where a section runs thousands of words but the edits are
 * localized — the flat `SideBySideDiff` stays the right tool for short texts.
 */

import { memo, useMemo, useState } from 'react';
import { diffLineBlocks } from '../../lib/diffLines';
import { diffWords } from '../../lib/diffWords';
import { renderRuns } from './diffRuns';

// Unchanged lines kept visible on each side of a change before collapsing.
const CONTEXT_LINES = 2;

function ChangeBlock({ oldLines, newLines }) {
  const oldText = oldLines.join('\n');
  const newText = newLines.join('\n');
  const { tooLarge, oldRuns, newRuns } = useMemo(() => diffWords(oldText, newText), [oldText, newText]);
  return (
    <div className="flex gap-4 px-3 py-2 bg-port-card/50 border-y border-port-border/60">
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed text-port-error">
        {tooLarge ? <span className="text-port-error">{oldText}</span> : renderRuns(oldRuns, false)}
      </div>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed text-port-success">
        {tooLarge ? <span className="text-port-success">{newText}</span> : renderRuns(newRuns, true)}
      </div>
    </div>
  );
}

function SameBlock({ lines, isFirst, isLast }) {
  const [expanded, setExpanded] = useState(false);
  // Context lines hug the adjacent change: none after the top of the diff,
  // none before the very end.
  const head = isFirst ? 0 : CONTEXT_LINES;
  const tail = isLast ? 0 : CONTEXT_LINES;
  const hidden = lines.length - head - tail;
  if (expanded || hidden <= 1) {
    return <div className="px-3 py-1.5 whitespace-pre-wrap break-words leading-relaxed text-gray-500">{lines.join('\n')}</div>;
  }
  return (
    <div className="text-gray-500">
      {head ? <div className="px-3 pt-1.5 whitespace-pre-wrap break-words leading-relaxed">{lines.slice(0, head).join('\n')}</div> : null}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full text-center text-[11px] text-gray-600 hover:text-gray-300 py-1"
        title="Show the unchanged lines"
      >
        ⋯ {hidden} unchanged line{hidden === 1 ? '' : 's'} ⋯
      </button>
      {tail ? <div className="px-3 pb-1.5 whitespace-pre-wrap break-words leading-relaxed">{lines.slice(lines.length - tail).join('\n')}</div> : null}
    </div>
  );
}

const HunkDiff = memo(function HunkDiff({
  oldText, newText, oldLabel = 'Before', newLabel = 'After', emptyLabel = 'No changes.',
}) {
  const oldStr = oldText || '';
  const newStr = newText || '';
  const blocks = useMemo(
    () => (oldStr === newStr ? null : diffLineBlocks(oldStr, newStr).blocks),
    [oldStr, newStr],
  );

  if (!blocks) {
    return (
      <div className="font-mono text-xs p-4 bg-port-bg">
        <div className="text-gray-500">{emptyLabel}</div>
      </div>
    );
  }

  const changeCount = blocks.filter((b) => b.type === 'change').length;

  return (
    <div className="font-mono text-xs bg-port-bg">
      <div className="flex items-center gap-4 px-3 py-2 border-b border-port-border/60 text-[10px] uppercase tracking-wider text-gray-500">
        <div className="min-w-0 flex-1">{oldLabel}</div>
        <div className="min-w-0 flex-1">{newLabel}</div>
        <span className="text-gray-600 normal-case tracking-normal whitespace-nowrap">
          {changeCount} changed region{changeCount === 1 ? '' : 's'}
        </span>
      </div>
      {blocks.map((b, i) => (b.type === 'same' ? (
        <SameBlock key={i} lines={b.lines} isFirst={i === 0} isLast={i === blocks.length - 1} />
      ) : (
        <ChangeBlock key={i} oldLines={b.oldLines} newLines={b.newLines} />
      )))}
    </div>
  );
});

export default HunkDiff;
