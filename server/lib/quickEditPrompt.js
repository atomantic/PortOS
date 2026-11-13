// The instruction a quick image edit wraps around the director's change (`withQuickEditInstruction` in
// services/imageGen/prepareParams.js). The second form is used whenever more references follow the edited image.
// A still made this way carries an edit instruction, never a description of its frame.
export const QUICK_EDIT_PREFIX = 'Edit the reference image: ';
export const QUICK_EDIT_PREFIX_WITH_REFERENCES = 'Edit the first reference image: ';

/** Whether a prompt is a quick-edit instruction rather than a frame description. */
export const isQuickEditPrompt = (prompt) => typeof prompt === 'string'
  && [QUICK_EDIT_PREFIX, QUICK_EDIT_PREFIX_WITH_REFERENCES].some((prefix) => prompt.trimStart().startsWith(prefix.trim()));
