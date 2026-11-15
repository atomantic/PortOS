/**
 * `v4()` thin wrapper over the global `crypto.randomUUID()`.
 *
 * Import-free, so a leaf the browser imports may reach it without a Node built-in — importable, not
 * browser-callable: `randomUUID` needs a secure context there, so client code mints through
 * `client/src/lib/uuid.js`.
 */

export const v4 = () => crypto.randomUUID();
