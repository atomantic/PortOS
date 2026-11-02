"""macOS release-agent supervisor launched by windowsAgentProcess.js.

macOS has no child subreaper or Job object for an unprivileged process, but
launchd starts every job in its own resource coalition. Coalition membership is
inherited on fork/exec, survives setsid and double forks, and cannot be left
without a privileged spawn; the kernel counts members that started and exited.
So the supervisor bootstraps a single-use launchd job running this file's
`--inner` stub, hands it the agent's stdio over a private Unix socket (or a
fresh pseudo-terminal, which it relays), and writes the settled receipt only
after the job is unloaded and the coalition reports no live member. Processes
launched outside the coalition through IPC (another launchd job, `open`, a
session manager) are out of scope, as they are for the Windows Job and the
Linux subreaper. Failure records carry an allowlisted stage and a numeric errno
only, never paths, PIDs, owner nonces or command text.
"""
import ctypes
import fcntl
import json
import os
import plistlib
import resource
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time
import tty
import uuid
from datetime import datetime, timezone

# Matches the CoS SIGTERM-to-SIGKILL escalation grace.
GRACE_SECONDS = 5
POLL_SECONDS = 0.05
HELLO_TIMEOUT_SECONDS = 15
PROC_PIDTBSDINFO, BSDINFO_SIZE = 3, 136
PROC_PIDCOALITIONINFO, COALITIONINFO_SIZE = 20, 40
SOL_LOCAL, LOCAL_PEERPID = 0, 2
ESRCH = 3
PROOF_KIND = 'launchd-coalition'

stage = 'request'
cancel_at = None
resized = False


class Failure(Exception):
    def __init__(self, code):
        super().__init__()
        self.code = code


def require(valid, code=0):
    if not valid:
        raise Failure(code)


libc = ctypes.CDLL('/usr/lib/libSystem.dylib', use_errno=True)
libc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
libc.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
libc.coalition_info_resource_usage.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]


def pid_info(pid, flavor, size):
    buffer = ctypes.create_string_buffer(size)
    if libc.proc_pidinfo(pid, flavor, 0, buffer, size) != size:
        return None
    return buffer.raw


def start_time(pid):
    """Microseconds since the epoch; a recycled PID has a different value."""
    raw = pid_info(pid, PROC_PIDTBSDINFO, BSDINFO_SIZE)
    if raw is None or struct.unpack_from('<I', raw, 12)[0] != pid:
        return None
    seconds, micros = struct.unpack_from('<QQ', raw, 120)
    return str(seconds * 1000000 + micros)


def coalition_of(pid):
    raw = pid_info(pid, PROC_PIDCOALITIONINFO, COALITIONINFO_SIZE)
    return None if raw is None else struct.unpack_from('<Q', raw, 0)[0]


def live_members(coalition):
    """Kernel count of live members; a reaped coalition is empty forever."""
    usage = (ctypes.c_uint64 * 64)()
    if libc.coalition_info_resource_usage(coalition, usage, ctypes.sizeof(usage)) != 0:
        error = ctypes.get_errno()
        require(error == ESRCH, error)
        return 0
    started, exited = usage[0], usage[1]
    require(started >= exited)
    return started - exited


def members(coalition):
    capacity = 4096
    while True:
        pids = (ctypes.c_int * capacity)()
        count = libc.proc_listallpids(pids, ctypes.sizeof(pids))
        require(count >= 0, ctypes.get_errno())
        if count < capacity:
            break
        capacity *= 2
    found = []
    for pid in pids[:count]:
        if pid > 0 and coalition_of(pid) == coalition:
            started = start_time(pid)
            if started is not None:
                found.append((pid, started))
    return found


def signal_coalition(coalition, signum):
    for pid, started in members(coalition):
        # Recheck both identities immediately before signalling, so a PID
        # recycled after the scan is never signalled.
        if coalition_of(pid) == coalition and start_time(pid) == started:
            try:
                os.kill(pid, signum)
            except OSError:
                pass


def request_stop(_signum, _frame):
    global cancel_at
    if cancel_at is None:
        cancel_at = time.monotonic()


def request_resize(_signum, _frame):
    global resized
    resized = True


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


def send_message(connection, value, fds=()):
    body = json.dumps(value, separators=(',', ':')).encode('utf-8')
    header = struct.pack('!Q', len(body))
    if fds:
        socket.send_fds(connection, [header], list(fds))
    else:
        connection.sendall(header)
    connection.sendall(body)


def receive_exact(connection, size):
    data = b''
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise EOFError()
        data += chunk
    return data


def receive_message(connection, max_fds=0):
    if max_fds:
        header, fds, _flags, _address = socket.recv_fds(connection, 8, max_fds)
        if not header:
            raise EOFError()
        header += receive_exact(connection, 8 - len(header))
    else:
        header, fds = receive_exact(connection, 8), []
    size = struct.unpack('!Q', header)[0]
    require(size <= 16 * 1024 * 1024)
    return json.loads(receive_exact(connection, size).decode('utf-8')), fds


def launchctl(*args):
    return subprocess.run(['/bin/launchctl', *args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=30).returncode


def bootstrap(private, label, token, server):
    plist = os.path.join(private, 'job.plist')
    with open(plist, 'wb') as file:
        plistlib.dump({
            'Label': label,
            'ProgramArguments': [sys.executable, '-I', os.path.abspath(__file__), '--inner', server, token],
            'RunAtLoad': True, 'KeepAlive': False, 'LaunchOnlyOnce': True,
            # The supervisor, not launchd, decides when the tree is finished.
            'AbandonProcessGroup': True, 'ProcessType': 'Standard',
        }, file)
    uid = os.getuid()
    for domain in (f'gui/{uid}', f'user/{uid}'):
        if launchctl('bootstrap', domain, plist) == 0:
            return f'{domain}/{label}'
    raise Failure(0)


def wait_for_hello(listener, token, own):
    listener.settimeout(HELLO_TIMEOUT_SECONDS)
    connection, _address = listener.accept()
    connection.settimeout(None)
    peer = connection.getsockopt(SOL_LOCAL, LOCAL_PEERPID)
    hello, _fds = receive_message(connection)
    require(hello.get('token') == token)
    coalition = coalition_of(peer)
    # A fresh launchd coalition holding only the stub proves the job is ours
    # and shares its accounting with nothing else, including this supervisor.
    require(coalition is not None and coalition != own and live_members(coalition) == 1)
    return connection, coalition


def relay(source, target):
    try:
        data = os.read(source, 65536)
    except OSError:
        return False
    if not data:
        return False
    view = memoryview(data)
    while view:
        try:
            view = view[os.write(target, view):]
        except BlockingIOError:
            select.select([], [target], [], POLL_SECONDS)
        except OSError:
            return True  # the reader went away; keep draining the agent
    return True


def copy_window_size(master):
    try:
        size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
        fcntl.ioctl(master, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def supervise(request, directory):
    """Run the agent in a fresh launchd coalition and return its exit code."""
    global stage, cancel_at, resized
    owner, command, args, cwd = request['owner'], request['command'], request['args'], request['cwd']
    pty = request.get('pty') is True
    stage = 'launch'
    require(isinstance(command, str) and isinstance(cwd, str) and isinstance(args, list)
            and all(isinstance(value, str) and '\0' not in value for value in [command, cwd, *args]))
    own = coalition_of(os.getpid())
    require(own is not None)
    # sun_path is 104 bytes on macOS, so the socket lives in a short private
    # directory rather than beside the receipts.
    private = tempfile.mkdtemp(prefix='portos-', dir='/tmp')
    label = f'local.portos.agent-settlement.{uuid.uuid4()}'
    token = str(uuid.uuid4())
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    service = connection = coalition = master = saved = None
    status, terminated, root, created = None, False, None, None
    try:
        server = os.path.join(private, 's')
        listener.bind(server)
        listener.listen(1)
        stage = 'job'
        service = bootstrap(private, label, token, server)
        stage = 'launch'
        connection, coalition = wait_for_hello(listener, token, own)
        if pty:
            master, slave = os.openpty()
            copy_window_size(master)
            if os.isatty(0):
                saved = termios.tcgetattr(0)
                tty.setraw(0)
            stdio = (slave, slave, slave)
        else:
            stdio = (0, 1, 2)
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        mask = os.umask(0o077)
        os.umask(mask)
        send_message(connection, {'command': command, 'args': args, 'cwd': cwd, 'env': dict(os.environ),
                                  'pty': pty, 'umask': mask, 'nofile': [soft, hard]}, stdio)
        if pty:
            os.close(slave)
            for descriptor in (0, master):
                fcntl.fcntl(descriptor, fcntl.F_SETFL, fcntl.fcntl(descriptor, fcntl.F_GETFL) | os.O_NONBLOCK)
        stage = 'process-times'
        started, _fds = receive_message(connection)
        if 'error' in started:
            raise Failure(int(started['error']))
        root, created = started.get('pid'), started.get('created')
        require(isinstance(root, int) and root > 0 and isinstance(created, str) and created.isdigit() and created != '0')
        stage = 'started-receipt'
        proof = {'kind': PROOF_KIND, 'version': 1, 'coalition': str(coalition)}
        write_receipt(directory, 'started.json', {'owner': owner, 'pid': root, 'created': created, 'proof': proof})
        stdin_open = pty
        while True:
            stage = 'reap'
            readers = [connection] if connection else []
            if master is not None:
                readers.append(master)
                if stdin_open:
                    readers.append(0)
            ready = []
            if readers:
                try:
                    ready = select.select(readers, [], [], POLL_SECONDS)[0]
                except InterruptedError:
                    pass
            else:
                time.sleep(POLL_SECONDS)
            if connection in ready:
                try:
                    message, _fds = receive_message(connection)
                    status = message.get('exit')
                    require(isinstance(status, int) and 0 <= status <= 255)
                except (EOFError, OSError):
                    pass
                connection.close()
                connection = None
            if master is not None and master in ready and not relay(master, 1):
                os.close(master)
                master = None
            if 0 in ready and master is not None and not relay(0, master):
                # The server's terminal closed: that is a hangup, not EOF input.
                stdin_open = False
                request_stop(None, None)
            if resized and master is not None:
                resized = False
                copy_window_size(master)
            # The server's durable stop request, which may predate the handlers.
            if cancel_at is None and os.path.exists(os.path.join(directory, 'cancel')):
                cancel_at = time.monotonic()
            if cancel_at is not None:
                stage = 'cancel'
                if time.monotonic() - cancel_at >= GRACE_SECONDS:
                    signal_coalition(coalition, signal.SIGKILL)
                elif not terminated:
                    signal_coalition(coalition, signal.SIGTERM)
                    terminated = True
            stage = 'accounting'
            if connection is None and live_members(coalition) == 0:
                break
        if master is not None:
            while relay(master, 1):
                pass
        stage = 'exit-code'
        if status is None:
            # Only an escalated stop kills the stub before it reports.
            require(cancel_at is not None)
            status = 128 + signal.SIGKILL
        stage = 'job'
        require(launchctl('bootout', service) in (0, 3, 113))
        service = None
        stage = 'accounting'
        require(live_members(coalition) == 0)
        stage = 'settled-receipt'
        write_receipt(directory, 'settled.json', {
            'version': 1, 'owner': owner, 'pid': root, 'created': created, 'proof': proof,
            'settledAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'active': 0, 'exitCode': status,
        })
        return status
    except BaseException:
        if coalition is not None:
            # Never leave a launched tree behind; it still earns no settled proof.
            deadline = time.monotonic() + GRACE_SECONDS * 2
            try:
                signal_coalition(coalition, signal.SIGTERM)
                while live_members(coalition) and time.monotonic() < deadline:
                    if time.monotonic() > deadline - GRACE_SECONDS:
                        signal_coalition(coalition, signal.SIGKILL)
                    time.sleep(POLL_SECONDS)
            except Exception:
                pass
        raise
    finally:
        if saved is not None:
            try:
                termios.tcsetattr(0, termios.TCSADRAIN, saved)
            except OSError:
                pass
        if service is not None:
            try:
                launchctl('bootout', service)
            except Exception:
                pass
        listener.close()
        shutil.rmtree(private, ignore_errors=True)


def inner(server, token):
    """launchd job body: run the agent inside this coalition and report it."""
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(server)
    send_message(connection, {'token': token})
    request, fds = receive_message(connection, 3)
    try:
        require(len(fds) == 3)
        command, args, cwd, env = request['command'], request['args'], request['cwd'], request['env']
        pty = request.get('pty') is True
        os.umask(request['umask'])
        soft, hard = request['nofile']
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
        except (OSError, ValueError):
            pass
        gate_read, gate_write = os.pipe()
        # os.pipe() descriptors are close-on-exec, so a successful exec closes
        # error_write and the stub reads EOF.
        error_read, error_write = os.pipe()
        child = os.fork()
        if child == 0:
            try:
                os.close(gate_write)
                os.close(error_read)
                if pty:
                    os.setsid()
                    fcntl.ioctl(fds[0], termios.TIOCSCTTY, 0)
                for target, source in enumerate(fds):
                    os.dup2(source, target)
                os.closerange(3, gate_read)
                os.closerange(gate_read + 1, error_write)
                os.closerange(error_write + 1, 65536)
                os.chdir(cwd)
                # Hold exec until the stub has recorded this PID's start time.
                os.read(gate_read, 1)
                os.close(gate_read)
                for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT, signal.SIGPIPE, signal.SIGXFSZ):
                    signal.signal(signum, signal.SIG_DFL)
                os.execve(command, [command, *args], env)
            except OSError as error:
                os.write(error_write, str(error.errno or 0).encode('ascii'))
            finally:
                os._exit(127)
        os.close(gate_read)
        os.close(error_write)
        for descriptor in fds:
            os.close(descriptor)
        created = start_time(child)
        os.write(gate_write, b'1')
        os.close(gate_write)
        failed = b''
        while True:
            chunk = os.read(error_read, 32)
            if not chunk:
                break
            failed += chunk
        os.close(error_read)
        if failed:
            os.waitpid(child, 0)
            send_message(connection, {'error': int(failed)})
            return 1
        send_message(connection, {'pid': child, 'created': created or '0'})
        # A stop is the supervisor's to deliver; the stub must outlive SIGTERM
        # long enough to report how the agent root ended.
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT):
            signal.signal(signum, lambda *_: None)
        while True:
            try:
                _pid, value = os.waitpid(child, 0)
                break
            except ChildProcessError:
                return 1
            except InterruptedError:
                continue
        code = os.WEXITSTATUS(value) if os.WIFEXITED(value) else 128 + os.WTERMSIG(value)
        send_message(connection, {'exit': code})
        return 0
    except Exception as error:
        try:
            send_message(connection, {'error': getattr(error, 'errno', None) or getattr(error, 'code', 0) or 0})
        except Exception:
            pass
        return 1


def probe():
    """Exercise the real launchd round trip; any failure leaves agents unsupervised."""
    directory = tempfile.mkdtemp(prefix='portos-probe-')
    try:
        owner = {'version': 1, 'agentId': 'probe', 'taskId': 'probe', 'startedAt': '1970-01-01T00:00:00.000Z',
                 'nonce': str(uuid.uuid4())}
        code = supervise({'owner': owner, 'command': '/usr/bin/true', 'args': [], 'cwd': '/'}, directory)
        require(code == 0 and os.path.exists(os.path.join(directory, 'settled.json')))
        return 0
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def main(argv):
    if len(argv) == 3 and argv[0] == '--inner':
        return inner(argv[1], argv[2])
    if argv == ['--probe']:
        return probe()
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, request_stop)
    signal.signal(signal.SIGWINCH, request_resize)
    directory = None
    try:
        require(len(argv) == 1)
        with open(argv[0], encoding='utf-8') as file:
            request = json.load(file)
        directory = os.path.dirname(argv[0])
        pty = request.get('pty') is True
        # A raw terminal delivers ^C/^\ to the agent as bytes; the supervisor
        # outlives them to settle whatever the agent leaves behind.
        signal.signal(signal.SIGINT, (lambda *_: None) if pty else request_stop)
        if pty:
            signal.signal(signal.SIGQUIT, lambda *_: None)
        return supervise(request, directory)
    except Exception as error:  # no exception text leaves this boundary
        code = error.code if isinstance(error, Failure) else (getattr(error, 'errno', None) or 0)
        if directory is not None:
            try:
                write_receipt(directory, 'failure.json', {'version': 1, 'stage': stage, 'code': code})
            except Exception:
                pass
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
