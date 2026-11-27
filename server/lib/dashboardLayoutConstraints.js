// Dashboard layout bounds shared by the request schemas and persisted layout sanitizer.

import { HHMM_STRICT_RE } from './timezone.js';


// Shape constraints shared with routes/dashboardLayouts.js#layoutSchema.
// Exported so routes build their Zod schema from the same source; edits
// here automatically flow to the API boundary.
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const ID_MAX_LENGTH = 60;

export const NAME_MAX_LENGTH = 80;

export const WIDGETS_MAX = 50;

export const WIDGET_ID_MAX_LENGTH = 80;

// Grid placement bounds. The dashboard is a 12-column responsive grid whose
// vertical placement is packed from measured content heights, so `x`/`w` are
// the only real coordinates. `order` is the reading/packing sequence, bounded
// by the widget count because a layout can never hold more entries than that.
// `h` stays bounded because a pinned cell renders at exactly that many rows.
export const GRID_COLS = 12;

export const GRID_ORDER_MAX = WIDGETS_MAX - 1;

export const GRID_ITEM_H_MAX = 50;

// Legacy `y` (pre-#4133 layouts and stale client bundles) is still accepted on
// read and converted to `order`; this bounds how far a hand-edited value can
// reach before it is discarded and resequenced.
export const GRID_LEGACY_Y_MAX = 200;

// Time-window auto-activation: HH:MM strings (24h). When a layout carries an
// activateWindow and the local clock falls inside it, the dashboard
// auto-selects that layout on a fresh visit (unless the user picked a
// different one today). Stored as a literal "HH:MM" pair so a hand-edited
// JSON is human-readable. Sourced from the strict (zero-padded) shared regex
// in server/lib/timezone.js; mirrored client-side in client/src/utils/timeWindow.js.
export const TIME_STRING_RE = HHMM_STRICT_RE;
