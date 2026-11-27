import { useState } from 'react';

export default function useNumericFieldDraft() {
  const [numericDrafts, setNumericDrafts] = useState({});
  const numericValue = (key, fallback) => (
    Object.hasOwn(numericDrafts, key) ? numericDrafts[key] : fallback
  );
  const updateNumericDraft = (key, raw, commit) => {
    setNumericDrafts((current) => ({ ...current, [key]: raw }));
    if (raw === '') return;
    const number = Number(raw);
    if (Number.isFinite(number)) commit(number);
  };
  const finishNumericDraft = (key) => {
    setNumericDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  return { numericValue, updateNumericDraft, finishNumericDraft };
}
