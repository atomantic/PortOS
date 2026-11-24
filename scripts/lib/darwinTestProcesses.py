"""Structured, same-user process metadata; stdout is a private pipe, never a log."""
import ctypes
import errno
import json
import os
import struct
import sys


PROC_PIDTBSDINFO = 3
PROC_PIDT_SHORTBSDINFO = 13
BSDINFO_LAYOUT = struct.Struct('=12I16s32s6I2Q')
SHORT_BSDINFO_LAYOUT = struct.Struct('=4I16s8I')
_UNSET = object()


def snapshot(
    requested=_UNSET,
    *,
    libc=None,
    libproc=None,
    get_errno=ctypes.get_errno,
    set_errno=ctypes.set_errno,
    getuid=os.getuid,
    kill=os.kill,
):
    if libc is None:
        libc = ctypes.CDLL(None, use_errno=True)
    if libproc is None:
        libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    uid = getuid()

    def identity(pid):
        buf = ctypes.create_string_buffer(BSDINFO_LAYOUT.size)
        # arg=1 includes zombies. A signalled child stays one until its parent
        # reaps it, and only its birth identity proves that the signal landed.
        set_errno(0)
        rc = libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, ctypes.c_uint64(1), buf, BSDINFO_LAYOUT.size)
        if rc != BSDINFO_LAYOUT.size:
            if rc <= 0 and get_errno() == errno.EPERM:
                # Setuid processes (e.g. /usr/bin/login with ruid=user, euid=0)
                # deny PROC_PIDTBSDINFO with EPERM even though os.kill(pid, 0)
                # succeeds. PROC_PIDT_SHORTBSDINFO exposes pbsi_uid so foreign-euid
                # rows are excluded without relaxing fail-closed handling for
                # unreadable same-euid processes.
                short_buf = ctypes.create_string_buffer(SHORT_BSDINFO_LAYOUT.size)
                short_rc = libproc.proc_pidinfo(
                    pid, PROC_PIDT_SHORTBSDINFO, ctypes.c_uint64(1), short_buf, SHORT_BSDINFO_LAYOUT.size
                )
                if short_rc == SHORT_BSDINFO_LAYOUT.size:
                    short_values = SHORT_BSDINFO_LAYOUT.unpack(short_buf.raw)
                    if short_values[0] == pid and short_values[6] != uid:
                        return False
            return None
        values = BSDINFO_LAYOUT.unpack(buf.raw)
        if values[3] != pid:
            return None
        if values[5] != uid:
            return False
        return {'pid': pid, 'ppid': values[4], 'start': f'{values[-2]}:{values[-1]}', 'terminal': values[1] == 5}

    if requested is _UNSET:
        requested = json.load(sys.stdin)
    inventory = requested is None
    if inventory:
        size = libproc.proc_listpids(1, 0, None, 0)
        if size <= 0 or size > 16 * 1024 * 1024:
            raise ValueError('process inventory unavailable')
        pids = (ctypes.c_int * (size // 4 + 256))()
        count = libproc.proc_listpids(1, 0, pids, ctypes.sizeof(pids))
        if count <= 0 or count >= ctypes.sizeof(pids):
            raise ValueError('incomplete process inventory')
        requested = list(pids[:count // 4])
    result = []
    metadata_reads = 0
    for pid in requested:
        if not isinstance(pid, int) or pid <= 1:
            continue
        before = identity(pid)
        if before is False:
            continue
        if before is None:
            try:
                kill(pid, 0)
            except OSError as error:
                if error.errno in (errno.ESRCH, errno.EPERM):
                    continue
            result.append({'pid': pid, 'ownershipComplete': False})
            continue
        # Keep ancestry even when arguments are unavailable. Missing ownership
        # evidence must never become permission to signal a process.
        record = dict(before)
        try:
            mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN / KERN_PROCARGS2
            length = ctypes.c_size_t()
            if libc.sysctl(mib, 3, None, ctypes.byref(length), None, 0) != 0:
                raise ValueError('arguments unavailable')
            if length.value < 4 or length.value > 4 * 1024 * 1024:
                raise ValueError('invalid argument length')
            buf = ctypes.create_string_buffer(length.value)
            if libc.sysctl(mib, 3, buf, ctypes.byref(length), None, 0) != 0:
                raise ValueError('arguments unavailable')
            data = buf.raw[:length.value]
            argc = struct.unpack_from('i', data)[0]
            if not 0 < argc < 65536:
                raise ValueError('invalid argument count')
            pos = data.index(b'\0', 4) + 1
            while data[pos] == 0:
                pos += 1
            args = []
            for _ in range(argc):
                end = data.index(b'\0', pos)
                args.append(data[pos:end].decode('utf-8', errors='strict'))
                pos = end + 1
            env = {}
            for entry in data[pos:].split(b'\0'):
                key, separator, value = entry.partition(b'=')
                if separator and key in (b'PORTOS_TEST_TEMP_ROOT', b'TMPDIR', b'VITEST', b'NODE_ENV'):
                    name = key.decode()
                    if name in env:
                        raise ValueError('duplicate ownership field')
                    env[name] = value.decode('utf-8', errors='strict')
            record.update(args=args, env=env)
            metadata_reads += 1
        except (ValueError, IndexError, UnicodeError):
            pass
        if identity(pid) == before:
            result.append(record)
    # An inventory without any ownership metadata must not pass for one that
    # found no owned process. Zombies carry none, so targeted reads are exempt.
    if inventory and metadata_reads == 0:
        raise ValueError('structured metadata unavailable')
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(snapshot()))
    except Exception:
        # No argv, environment, or OS error payload may escape through diagnostics.
        sys.exit(1)
