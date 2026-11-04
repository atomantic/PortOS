"""Linux release-agent supervisor launched by windowsAgentProcess.js.

The supervisor makes itself a child subreaper, launches the agent root and
reaps until wait() reports ECHILD. A descendant whose ancestors exit (setsid,
double fork) is reparented here before its parent can be reaped, so ECHILD
proves the whole tree has exited. Only then is the settled receipt written.
A stop arrives as the server's `cancel` file or as SIGTERM/SIGHUP.
Processes started outside the tree through IPC (systemd-run, at) are out of
scope. Failure records carry an allowlisted stage and a numeric errno only,
never paths, PIDs, owner nonces or command text.
"""
import ctypes
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

PR_SET_CHILD_SUBREAPER = 36
# Matches the CoS SIGTERM-to-SIGKILL escalation grace.
GRACE_SECONDS = 5
POLL_SECONDS = 0.05

stage = 'request'
cancel_at = None


class Failure(Exception):
    def __init__(self, code):
        super().__init__()
        self.code = code


def require(valid, code=0):
    if not valid:
        raise Failure(code)


def request_stop(_signum, _frame):
    global cancel_at
    if cancel_at is None:
        cancel_at = time.monotonic()


def become_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0, ctypes.get_errno())


def stat_fields(pid):
    with open(f'/proc/{pid}/stat', 'rb') as file:
        data = file.read()
    # The command name may contain spaces or parentheses; fields resume after
    # the last ')'. Index 1 is field 4 (ppid), index 19 is field 22 (starttime).
    return data[data.rindex(b')') + 2:].split()


def start_time(pid):
    return stat_fields(pid)[19].decode('ascii')


def descendants():
    children = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            fields = stat_fields(name)
        except (OSError, ValueError, IndexError):
            continue  # exited during the scan
        children.setdefault(int(fields[1]), []).append((int(name), fields[19].decode('ascii')))
    tree, frontier = [], [os.getpid()]
    while frontier:
        for pid, started in children.get(frontier.pop(), []):
            tree.append((pid, started))
            frontier.append(pid)
    return tree


def signal_tree(signum):
    for pid, started in descendants():
        try:
            descriptor = os.pidfd_open(pid)
        except OSError:
            continue  # already gone
        try:
            # The pidfd pins one process. A matching start time after opening it
            # proves the scanned descendant, never a recycled PID, is signalled.
            if start_time(pid) == started:
                signal.pidfd_send_signal(descriptor, signum)
        except OSError:
            pass
        finally:
            os.close(descriptor)


def drain(root, directory):
    """Reap until ECHILD; on cancellation SIGTERM the tree, then SIGKILL it."""
    global stage, cancel_at
    status, terminated = None, False
    while True:
        stage = 'reap'
        try:
            while True:
                pid, value = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
                if pid == root:
                    status = value
        except ChildProcessError:
            require(status is not None)
            return status
        # The server's durable stop request, which may predate the handlers.
        if cancel_at is None and os.path.exists(os.path.join(directory, 'cancel')):
            cancel_at = time.monotonic()
        if cancel_at is not None:
            stage = 'cancel'
            if time.monotonic() - cancel_at >= GRACE_SECONDS:
                signal_tree(signal.SIGKILL)
            elif not terminated:
                signal_tree(signal.SIGTERM)
                terminated = True
        time.sleep(POLL_SECONDS)


def write_receipt(directory, name, value):
    # A reader observes either no record or the complete one; an existing
    # record is never replaced.
    path = os.path.join(directory, name)
    temporary = path + '.pending'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as file:
        json.dump(value, file, separators=(',', ':'))
        file.flush()
        os.fsync(file.fileno())
    os.link(temporary, path)
    os.unlink(temporary)


def probe():
    become_subreaper()
    os.close(os.pidfd_open(os.getpid()))
    require(callable(signal.pidfd_send_signal))
    return 0


def main(argv):
    global stage, cancel_at
    if argv == ['--probe']:
        return probe()
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, request_stop)
    directory, root = None, None
    try:
        require(len(argv) == 1)
        with open(argv[0], encoding='utf-8') as file:
            request = json.load(file)
        directory = os.path.dirname(argv[0])
        owner, command, args, cwd = request['owner'], request['command'], request['args'], request['cwd']
        pty = request.get('pty') is True
        # A terminal delivers ^C/^\ to the agent's foreground group itself; the
        # supervisor outlives them to settle whatever the agent leaves behind.
        signal.signal(signal.SIGINT, (lambda *_: None) if pty else request_stop)
        if pty:
            signal.signal(signal.SIGQUIT, lambda *_: None)
        stage = 'subreaper'
        become_subreaper()
        stage = 'launch'
        require(isinstance(command, str) and isinstance(cwd, str) and isinstance(args, list)
                and all(isinstance(value, str) and '\0' not in value for value in [command, cwd, *args]))
        try:
            # Inherit the composed environment and stdio/PTY; restore default
            # SIGPIPE/SIGXFSZ dispositions that Python itself ignores.
            child = subprocess.Popen([command, *args], executable=command, cwd=cwd, close_fds=True, restore_signals=True)
        except OSError as error:
            raise Failure(error.errno or 0) from None
        root = child.pid
        stage = 'process-times'
        created = start_time(root)
        require(created.isdigit() and created != '0')
        stage = 'started-receipt'
        write_receipt(directory, 'started.json', {'owner': owner, 'pid': root, 'created': created})
        status = drain(root, directory)
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
        child.returncode = code
        stage = 'settled-receipt'
        write_receipt(directory, 'settled.json', {
            'version': 1, 'owner': owner, 'pid': root, 'created': created,
            'settledAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'active': 0, 'exitCode': code,
        })
        return code
    except Exception as error:  # no exception text leaves this boundary
        code = error.code if isinstance(error, Failure) else (getattr(error, 'errno', None) or 0)
        failed = stage
        if root is not None:
            # Never leave a launched tree behind; it still earns no settled proof.
            cancel_at = time.monotonic() - GRACE_SECONDS
            try:
                drain(root, directory)
            except Exception:
                pass
        if directory is not None:
            try:
                write_receipt(directory, 'failure.json', {'version': 1, 'stage': failed, 'code': code})
            except Exception:
                pass
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
