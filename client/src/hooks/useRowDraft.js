// Multi-column row-draft buffer keyed by column name. Row-level analogue of
// `useFieldDraft`. Sibling-draft "ride-along" race protection: when a fast
// A-blur → B-blur sequence commits B before the parent has re-rendered with
// A's committed value, spreading the stale `row` prop alone would overwrite
// A back to its original. Merging the pending `drafts` map into the commit
// payload lets A's in-flight edit ride along on B's commit.
import { useRef, useState } from 'react';
import { useDraftCommitMode } from './useDraftCommitMode';

export default function useRowDraft(row, onChange) {
  const immediate = useDraftCommitMode() === 'change';
  const [drafts, setDrafts] = useState({});
  const pending = useRef({});
  const previousRow = useRef(row);
  if (previousRow.current !== row) { previousRow.current = row; pending.current = {}; }

  const draftFor = (col) => (col in drafts ? drafts[col] : (row[col] || ''));

  const setDraft = (col, v) => {
    if (immediate) {
      pending.current = { ...pending.current, [col]: v };
      onChange({ ...row, ...pending.current });
    } else setDrafts((p) => ({ ...p, [col]: v }));
  };

  const clearDraft = (col) => setDrafts((prev) => {
    const next = { ...prev };
    delete next[col];
    return next;
  });

  const commit = (col) => {
    if (immediate) return;
    if (!(col in drafts)) return;
    const v = drafts[col];
    if (v === (row[col] || '')) {
      clearDraft(col);
      return;
    }
    const nextRow = { ...row, ...drafts, [col]: v };
    clearDraft(col);
    onChange(nextRow);
  };

  return { draftFor, setDraft, commit };
}
