// Pending field edits over a live saved record, retained until their own save succeeds.
import { useState } from 'react';

// A pending edit overrides only its own saved field. A successful (possibly
// normalized) server response releases it unless the user edited again.
export default function usePendingFieldEdits(saved) {
  const [edits, setEdits] = useState({});
  const update = (key, value) => setEdits(current => ({ ...current, [key]: { value } }));
  const value = (key) => edits[key]?.value ?? saved[key];
  const clear = (key, edit) => setEdits(current => {
    if (current[key] !== edit) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
  const persist = (key, edit, submit) => Promise.resolve(submit(edit.value)).then(result => {
    if (result) clear(key, edit);
  });
  const commit = (key, submit) => {
    const edit = edits[key];
    if (!edit) return;
    if (edit.value === saved[key]) clear(key, edit);
    else return persist(key, edit, submit);
  };
  const choose = (key, value, submit) => {
    const edit = { value };
    setEdits(current => ({ ...current, [key]: edit }));
    return persist(key, edit, submit);
  };
  return { value, update, commit, choose };
}
