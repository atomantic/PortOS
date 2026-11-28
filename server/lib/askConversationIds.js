// Canonical Ask conversation IDs and modes shared by persistence and request validation.


export const VALID_MODES = new Set(['ask', 'advise', 'draft']);

// Pad base36-ms to 9 chars (36^9 > 1e14, valid until year ~5100) so
// filename lexical order always matches chronological order — without
// padding, a digit rollover would make a newer id sort *before* an older
// one and the newest-first listing would silently flip. The hex suffix is
// the first 8 chars of a UUID. The regex is locked to those exact widths
// so non-canonical ids (which would land on disk with the wrong sort key)
// never pass validation at any layer.
export const BASE36_TS_WIDTH = 9;

const HEX_SUFFIX_WIDTH = 8;

export const ID_RE = new RegExp(`^ask_[a-z0-9]{${BASE36_TS_WIDTH}}_[a-f0-9]{${HEX_SUFFIX_WIDTH}}$`);
