import { describe, expect, it } from 'vitest';
import { DB_EXTENSION_UNAVAILABLE, translateExtensionLibraryError } from './pgExtensionError.js';

const pgError = (code, message) => Object.assign(new Error(message), { code });

describe('translateExtensionLibraryError', () => {
  it('turns a missing extension library into a coded 503 naming the fix', () => {
    const original = pgError('58P01', 'could not access file "$libdir/vector": No such file or directory');
    const err = translateExtensionLibraryError(original);
    expect(err).not.toBe(original);
    expect(err).toMatchObject({ status: 503, code: DB_EXTENSION_UNAVAILABLE, library: 'vector', cause: original });
    expect(err.message).toContain('"vector"');
    expect(err.message).toContain('npm run setup:db');
  });

  it('leaves other undefined-file errors and other SQLSTATEs alone', () => {
    const otherFile = pgError('58P01', 'could not open file "base/16384/1234": No such file or directory');
    const unique = pgError('23505', 'duplicate key value violates unique constraint');
    expect(translateExtensionLibraryError(otherFile)).toBe(otherFile);
    expect(translateExtensionLibraryError(unique)).toBe(unique);
    expect(translateExtensionLibraryError(undefined)).toBeUndefined();
  });
});
