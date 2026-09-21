import { sha256Text } from '../../lib/fileCore.js';

// Pin pipeline snapshots to their source content. Preserve the existing empty
// fallback so stored hashes keep the same cache and staleness semantics.
export const contentHash = (text) => sha256Text(text || '');
