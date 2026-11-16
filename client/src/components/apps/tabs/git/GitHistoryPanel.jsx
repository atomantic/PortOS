import { memo } from 'react';
import { formatDateNumeric } from '../../../../utils/formatters';

// Recent commits on the current branch. Memoized on the `commits` array, which
// only changes identity when git info reloads, so unrelated tab state (an
// in-flight flag, an open confirm) does not re-render the list.
function GitHistoryPanel({ commits }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Commits</h3>
      <div className="space-y-2">
        {commits?.map((commit, i) => (
          <div key={i} className="py-2 border-b border-port-border last:border-0">
            <div className="flex items-center gap-2">
              <code className="text-xs text-port-accent">{commit.hash}</code>
              <span className="text-sm text-white truncate">{commit.message}</span>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {commit.author} • {formatDateNumeric(commit.date)}
            </div>
          </div>
        ))}
        {(!commits || commits.length === 0) && (
          <div className="text-gray-500 text-sm">No commits</div>
        )}
      </div>
    </div>
  );
}

export default memo(GitHistoryPanel);
