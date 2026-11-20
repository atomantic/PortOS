// Double-fork launcher. argv: <controlDir> <bin> <bin-args…> — passed as
// positional params (NOT interpolated into the script string) so paths/args
// with spaces or shell metacharacters can't break quoting or inject.
//   $1            → control dir (holds stdout.log/stderr.log/pid/exit)
//   "$@" (after shift) → the job command + its args
// The `{ … } &` group is a backgrounded subshell; when the outer `sh` hits EOF
// and exits, that subshell reparents to init, taking the job with it.
export const POSIX_DETACHED_LAUNCHER = `
d="$1"; shift
{
  "$@" > "$d/stdout.log" 2> "$d/stderr.log" &
  child=$!
  printf '%s' "$child" > "$d/pid"
  wait "$child"
  printf '%s' "$?" > "$d/exit"
} &
`;

// The supervisor subshell of EVERY detached launch — including launches from
// versions that predate the writer registry — runs this exact script text.
export const isDetachedSupervisorCommand = (command) => command.includes('d="$1"; shift') && command.includes('$d/pid');
