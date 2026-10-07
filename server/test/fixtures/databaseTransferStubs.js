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
//
// The fixture also OWNS what it starts. Each stub registers its pid and logs
// start/exit in phases.log (pid, kind and event only: never argv, environment
// or paths), and the harness records timed marks for its own awaits. That is
// the whole of `report()`, so a stalled case names its last phase and child
// state without exposing command lines or credentials, and `contain()` is what
// a teardown calls to stop the stubs and wait out the in-flight transfer before
// the disposable root is removed.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from '../processAlive.js';

export const STUB_DUMP_BODY = 'CREATE TABLE example_record (id int);\n';
export const STUB_DUMP_COMPLETE = `${STUB_DUMP_BODY}--\n-- PostgreSQL database dump complete\n--\n\n`;

const POLL_MS = 20;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_MARKS = 200;

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
  const phase = (kind, event) => `echo "$$ ${kind} ${event} $(date +%s)" >> "$R/phases.log"`;
  const pause = kind => `: > "$R/${kind}-started"; while [ ! -e "$R/${kind}-release" ]; do sleep 0.05; done`;
  writeStub(join(bin, 'uname'), '#!/bin/sh\necho Linux\n');
  writeStub(join(bin, 'pg_dump'), `#!/bin/sh
R=${R}
mode=$(cat "$R/dump-mode" 2>/dev/null || echo ok)
${logInvocation('pg_dump')}
${phase('dump', 'start')}
trap '${phase('dump', 'exit')}' EXIT
writer=none
if [ -s "$R/writer.pid" ]; then
  wpid=$(cat "$R/writer.pid")
  if kill -0 "$wpid" 2>/dev/null; then
    if [ -f "/proc/$wpid/stat" ] && awk '{if ($NF=="") exit; sub(/^.*\)/, ""); if ($1=="Z") exit 1}' "/proc/$wpid/stat" 2>/dev/null; then
      writer=alive
    elif [ ! -f "/proc/$wpid/stat" ]; then
      writer=alive
    else
      writer=dead
    fi
  else
    writer=dead
  fi
fi
echo "dump writer=$writer" >> "$R/events.log"
if [ "$mode" = pause ]; then ${pause('dump')}; fi
case "$mode" in
  fail) printf 'DROP TABLE example_record;\\n'; exit 1 ;;
  incomplete) printf '%s' ${quote(STUB_DUMP_BODY)}; exit 0 ;;
esac
if [ -f "$R/dump.sql" ]; then cat "$R/dump.sql"; else printf '%s' ${quote(STUB_DUMP_COMPLETE)}; fi
`);
  writeStub(join(bin, 'psql'), `#!/bin/sh
R=${R}
case "$*" in *--single-transaction*) ;; *) echo "psql-other $*" >> "$R/calls.log"; exit 0 ;; esac
mode=$(cat "$R/import-mode" 2>/dev/null || echo ok)
${logInvocation('psql')}
${phase('import', 'start')}
trap '${phase('import', 'exit')}' EXIT
echo "import-start" >> "$R/events.log"
if [ "$mode" = pause ]; then ${pause('import')}; fi
cat > "$R/import.pending"
if [ "$mode" = fail ]; then rm -f "$R/import.pending"; exit 3; fi
mv "$R/import.pending" "$R/imported.sql"
echo "import-commit" >> "$R/events.log"
`);
  const read = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');

  // Stub children by pid, from their own start/exit lines: { pid, kind, running }.
  const children = () => {
    const byPid = new Map();
    for (const line of read('phases.log').split('\n').filter(Boolean)) {
      const [pid, kind, event] = line.split(' ');
      byPid.set(Number(pid), { pid: Number(pid), kind, running: event === 'start' });
    }
    return [...byPid.values()];
  };
  const marks = [];
  const pending = new Set();
  const mark = (name, ms = null) => {
    marks.push({ name, ms, at: Date.now() });
    if (marks.length > MAX_MARKS) marks.shift();
  };
  const timed = async (name, run) => {
    const began = Date.now();
    mark(name + ':begin');
    try { return await run(); } finally { mark(name + ':end', Date.now() - began); }
  };
  // One line, bounded: mark names the harness chose, child kind/state, and
  // durations. Nothing read from the stubs' argv, environment or paths.
  const report = (extra = '') => {
    const last = marks.at(-1);
    const totals = new Map();
    for (const entry of marks.filter(value => value.ms !== null)) {
      const name = entry.name.replace(/:end$/, '');
      const total = totals.get(name) ?? { count: 0, ms: 0, max: 0 };
      totals.set(name, { count: total.count + 1, ms: total.ms + entry.ms, max: Math.max(total.max, entry.ms) });
    }
    const slow = [...totals].sort((x, y) => y[1].ms - x[1].ms).slice(0, 4)
      .map(([name, total]) => `${name}=${total.count}x/${total.ms}ms(max ${total.max}ms)`);
    const states = children().map(child => `${child.kind}:${child.running ? (isProcessAlive(child.pid) ? 'running' : 'gone') : 'exited'}`);
    return [`last=${last ? `${last.name}(${Date.now() - last.at}ms ago)` : 'none'}`,
      `slowest=${slow.join(',') || 'none'}`, `children=${states.join(',') || 'none'}`,
      `pending=${pending.size}`, extra].filter(Boolean).join(' ');
  };

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
    timed,
    report,
    // The in-flight workflow promise a case started. A timed-out case's
    // transfer keeps running unless contain() settles it.
    track: promise => {
      const entry = promise.then(() => {}, () => {}).finally(() => pending.delete(entry));
      pending.add(entry);
      return promise;
    },
    // Teardown: SIGKILL only the stubs this fixture's own phases.log says are
    // still running, wait until each is gone, then wait (bounded) for tracked
    // workflows to settle. A killed stub fails its export/import, which is how
    // an otherwise uncancellable await chain ends. Returns false when something
    // is still in flight, so the caller keeps the root rather than letting it
    // write into a removed one. A timeout is never taken as completion.
    contain: async ({ settleMs = 15_000 } = {}) => {
      const deadline = Date.now() + settleMs;
      const owned = () => children().filter(child => child.running && isProcessAlive(child.pid));
      while (Date.now() < deadline && (owned().length > 0 || pending.size > 0)) {
        for (const child of owned()) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } }
        await sleep(POLL_MS);
      }
      return owned().length === 0 && pending.size === 0;
    },
  };
}
