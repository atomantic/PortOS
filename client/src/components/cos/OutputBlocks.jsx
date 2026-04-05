import { useMemo, useState } from 'react';
import MarkdownOutput from './MarkdownOutput';

export const isToolLine = (line) =>
  line.startsWith('🔧') || line.startsWith('  →') || line.startsWith('  ↳') || line.startsWith('[stderr]');

const INITIAL_BLOCKS = 80;
const LOAD_MORE_BLOCKS = 120;

function renderBlock(block, i) {
  if (block.type === 'tool') {
    const line = block.line;
    if (line.startsWith('🔧')) {
      return <div key={i} className="py-0.5 text-xs font-mono text-port-accent break-all">{line}</div>;
    }
    if (line.startsWith('  →')) {
      return <div key={i} className="py-0.5 text-xs font-mono text-gray-500 pl-4 break-all">{line.substring(4)}</div>;
    }
    if (line.startsWith('  ↳')) {
      return <div key={i} className="py-0.5 text-xs font-mono text-gray-600 pl-4 break-all">{line.substring(4)}</div>;
    }
    return <div key={i} className="py-0.5 text-xs font-mono text-yellow-500 break-all">{line}</div>;
  }
  return <MarkdownOutput key={i} content={block.content} />;
}

export default function OutputBlocks({ output }) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_BLOCKS);

  // Group consecutive lines: tool lines render as monospace, content lines as markdown
  const blocks = useMemo(() => {
    const result = [];
    let mdLines = [];

    const flushMd = () => {
      if (mdLines.length > 0) {
        result.push({ type: 'md', content: mdLines.join('\n') });
        mdLines = [];
      }
    };

    for (const o of output) {
      const line = o.line || '';
      if (isToolLine(line)) {
        flushMd();
        result.push({ type: 'tool', line });
      } else {
        mdLines.push(line);
      }
    }
    flushMd();
    return result;
  }, [output]);

  const hasMore = blocks.length > visibleCount;

  return (
    <div className="space-y-0.5 min-w-0 overflow-hidden">
      {blocks.slice(0, visibleCount).map(renderBlock)}
      {hasMore && (
        <button
          onClick={() => setVisibleCount(prev => prev + LOAD_MORE_BLOCKS)}
          className="w-full py-2 text-xs text-port-accent hover:text-white bg-port-border/30 hover:bg-port-border/50 rounded transition-colors min-h-[40px]"
        >
          Show more ({blocks.length - visibleCount} remaining)
        </button>
      )}
    </div>
  );
}
