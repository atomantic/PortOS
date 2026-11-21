/**
 * PostgreSQL reports a missing extension shared library (SQLSTATE 58P01,
 * `could not access file "$libdir/vector"`) the same way for every query that
 * touches the extension. The usual cause is a Homebrew upgrade that replaced
 * the extension bottle with one built only for newer PostgreSQL majors, so
 * the running server can no longer load it. That is an environment fault the
 * user fixes with `npm run setup:db`, not a defect in the calling route.
 */

export const DB_EXTENSION_UNAVAILABLE = 'DB_EXTENSION_UNAVAILABLE';

const LIBDIR_FILE = /\$libdir\/([\w.-]+)/;

/**
 * Map a pg "extension library missing" error to a coded 503 that names the
 * fix. Returns any other value unchanged so callers can rethrow the result.
 */
export function translateExtensionLibraryError(err) {
  if (err?.code !== '58P01') return err;
  const library = LIBDIR_FILE.exec(err.message || '')?.[1];
  if (!library) return err;
  return Object.assign(
    new Error(`PostgreSQL cannot load the "${library}" extension library, so database features that use it are unavailable. This usually follows a Homebrew upgrade; run: npm run setup:db`),
    { status: 503, code: DB_EXTENSION_UNAVAILABLE, library, cause: err },
  );
}
