/** Shared key constraints and byte limits for an autonomous job notepad. */

export const MAX_KEY_CHARS = 128;
export const MAX_VALUE_BYTES = 16 * 1024;
export const MAX_JOB_TOTAL_BYTES = 64 * 1024;
export const NOTE_KEY_PATTERN = /^[a-zA-Z0-9._:-]+$/;
