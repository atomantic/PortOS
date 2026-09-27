// Disposable stand-ins for the PostgreSQL client tools scripts/db.sh runs
// during an offline transfer. No real database is ever reached: pg_dump and
// psql are shell stubs placed first on PATH, and a `uname` stub keeps db.sh
// from prepending Homebrew's real PostgreSQL on macOS. Test endpoints use
// `.invalid` hosts so even an unexpected real client could not connect.
//
// Each stub logs its argv and every PG* variable it received, and its behavior
// is switched by mode files: dump-mode (ok | fail | incomplete | pause) and
// import-mode (ok | fail | pause). A paused stub publishes `<kind>-started`
// and waits for `<kind>-release`. events.log orders stops, dumps and imports.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STUB_DUMP_BODY = 'CREATE TABLE example_record (id int);\n';
export const STUB_DUMP_COMPLETE = `${STUB_DUMP_BODY}--\n-- PostgreSQL database dump complete\n--\n\n`;

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function writeStub(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

export function installDatabaseStubs(root) {
  const dir = join(root, 'stubs');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const R = quote(dir);
  const logInvocation = name => `{ echo "${name} $*"; env | grep '^PG' | sort | sed 's/^/env /'; } >> "$R/calls.log"`;
  const pause = kind => `: > "$R/${kind}-started"; while [ ! -e "$R/${kind}-release" ]; do sleep 0.05; done`;
  writeStub(join(bin, 'uname'), '#!/bin/sh\necho Linux\n');
  writeStub(join(bin, 'pg_dump'), `#!/bin/sh
R=${R}
mode=$(cat "$R/dump-mode" 2>/dev/null || echo ok)
${logInvocation('pg_dump')}
writer=none
if [ -s "$R/writer.pid" ]; then
  if kill -0 "$(cat "$R/writer.pid")" 2>/dev/null; then writer=alive; else writer=dead; fi
fi
echo "dump writer=$writer" >> "$R/events.log"
if [ "$mode" = pause ]; then ${pause('dump')}; fi
case "$mode" in
  fail) printf 'DROP TABLE example_record;\\n'; exit 1 ;;
  incomplete) printf '%s' ${quote(STUB_DUMP_BODY)}; exit 0 ;;
esac
printf '%s' ${quote(STUB_DUMP_COMPLETE)}
`);
  writeStub(join(bin, 'psql'), `#!/bin/sh
R=${R}
case "$*" in *--single-transaction*) ;; *) echo "psql-other $*" >> "$R/calls.log"; exit 0 ;; esac
mode=$(cat "$R/import-mode" 2>/dev/null || echo ok)
${logInvocation('psql')}
echo "import-start" >> "$R/events.log"
if [ "$mode" = pause ]; then ${pause('import')}; fi
cat > "$R/import.pending"
if [ "$mode" = fail ]; then rm -f "$R/import.pending"; exit 3; fi
mv "$R/import.pending" "$R/imported.sql"
echo "import-commit" >> "$R/events.log"
`);
  const read = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return {
    dir,
    bin,
    setMode: (kind, mode) => writeFileSync(join(dir, `${kind}-mode`), mode),
    release: kind => writeFileSync(join(dir, `${kind}-release`), ''),
    started: kind => existsSync(join(dir, `${kind}-started`)),
    event: line => appendFileSync(join(dir, 'events.log'), line + '\n'),
    events: () => read('events.log').split('\n').filter(Boolean),
    calls: () => read('calls.log'),
    imported: () => read('imported.sql'),
    // argv lines only (env lines are separate)
    invocations: name => read('calls.log').split('\n').filter(line => line.startsWith(name + ' ')),
    // PG* variable names each stub received
    receivedVariables: () => [...new Set(read('calls.log').split('\n')
      .filter(line => line.startsWith('env ')).map(line => line.slice(4).split('=')[0]))].sort(),
    writerPid: pid => writeFileSync(join(dir, 'writer.pid'), String(pid)),
  };
}
