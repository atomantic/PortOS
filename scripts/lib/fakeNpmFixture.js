// A fake `npm` on PATH for runner tests: it prints its arguments and the selection file it was handed.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Install an `npm` (POSIX shim and Windows `.cmd`) in `fixture` that runs `body` with Node. */
export function installFakeNpm(fixture, body) {
  const npmScript = join(fixture, 'npm.cjs');
  writeFileSync(npmScript, body);
  writeFileSync(join(fixture, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${npmScript}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(fixture, 'npm.cmd'), `@"${process.execPath}" "${npmScript}" %*\r\n`);
}

/** A fake `npm` body that echoes its arguments and the Vitest selection file as one JSON line. */
export const REPORTING_NPM = 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), '
  + 'selection: JSON.parse(require("fs").readFileSync(process.env.PORTOS_CI_TEST_SELECTION, "utf8")) }) + "\\n");';
