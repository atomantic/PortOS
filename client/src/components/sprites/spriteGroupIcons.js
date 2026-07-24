/**
 * React-side companion to the pure `spriteRecordGroups` lib. That lib stays
 * React-free (a lib module can't import lucide components without pulling React
 * into its barrel), so the lucide mapping for the three sprite noun-groups
 * lives here instead — one shared copy for every React consumer (the Sprite
 * Manager page, the catalog, the search picker) rather than a per-file dupe.
 */

import { PersonStanding, MapPin, Package } from 'lucide-react';
import { groupKeyForKind } from '../../lib/spriteRecordGroups.js';

// Keyed by the group `key` the lib assigns (characters / places / objects).
export const GROUP_ICONS = { characters: PersonStanding, places: MapPin, objects: Package };

// Resolve a record `kind` straight to its group icon — collapses the repeated
// `GROUP_ICONS[groupKeyForKind(kind)] || Package` idiom. Package is the
// fallback for an unknown/legacy kind (mirrors the lib's Objects fold).
export const groupIconForKind = (kind) => GROUP_ICONS[groupKeyForKind(kind)] || Package;
