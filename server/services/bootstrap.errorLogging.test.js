/**
 * Boot errors must retain their source location (#6934). This test extracts
 * the small logger without importing bootstrap.js, whose module graph starts
 * the real service wiring as a side effect of evaluation.
 */

import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractDeclaration } from '../lib/mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'bootstrap.js'), 'utf-8').replace(/\r\n/g, '\n');

const loadLogger = (console) => runInNewContext(`
  ${extractDeclaration(source, 'logBootstrapFailure')}
  logBootstrapFailure;
`, { console, String });

describe('boot failure logging (#6934)', () => {
  it('includes an Error stack with the boot failure message', () => {
    const error = vi.fn();
    const logBootstrapFailure = loadLogger({ error });

    logBootstrapFailure('❌ Backup scheduler init failed', new Error('database unavailable'));

    expect(error).toHaveBeenCalledWith(
      '❌ Backup scheduler init failed: database unavailable',
      expect.stringContaining('Error: database unavailable'),
    );
  });

  it('supports warning and log severity without dropping the stack', () => {
    const warn = vi.fn();
    const logBootstrapFailure = loadLogger({ error: vi.fn(), warn });
    const error = new Error('restore failed');

    logBootstrapFailure('⚠️ tailcat restore failed', error, warn);

    expect(warn).toHaveBeenCalledWith(
      '⚠️ tailcat restore failed: restore failed',
      expect.stringContaining('Error: restore failed'),
    );
  });
});
