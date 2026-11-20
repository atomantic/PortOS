import { useState } from 'react';

// Keep the last edit while the panel is mounted, and use it only in its original scope.
export default function useScopedDraft(scopeKey, fallback) {
  const [draft, setDraft] = useState(null);
  const hasDraft = draft !== null && draft.scopeKey === scopeKey;
  return {
    value: hasDraft ? draft.value : fallback,
    setValue: (value) => setDraft({ scopeKey, value }),
    clear: () => setDraft(null),
    hasDraft,
  };
}
