import { createContext, useContext } from 'react';

// The same fields can blur-save a universe or edit a parent-owned Save draft.
export const DraftCommitMode = createContext('blur');
export const useDraftCommitMode = () => useContext(DraftCommitMode);
