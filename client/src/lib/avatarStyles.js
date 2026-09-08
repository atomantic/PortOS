/**
 * Re-export of the authoritative CoS avatar-style vocabulary in
 * `server/lib/avatarStyles.js`.
 *
 * The registry lives server-side because the server's `avatarStyle` zod enum
 * needs it too, and the dependency direction is one-way: the client imports
 * pure `server/lib` leaves, never the reverse (a client-only dependency added
 * to a file the server imports breaks the server CI job). This shim keeps the
 * `lib/avatarStyles` import path every UI consumer already uses.
 */
export {
  AVATAR_STYLES,
  AVATAR_STYLE_IDS,
  AVATAR_STYLE_LABELS,
  WEBGL_AVATAR_STYLE_IDS,
} from '../../../server/lib/avatarStyles.js';
