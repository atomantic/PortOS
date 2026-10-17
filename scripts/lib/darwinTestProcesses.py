"""Structured, same-user process metadata; stdout is a private pipe, never a log."""
import ctypes
import json
import os
import struct
import sys


def snapshot():
    libc = ctypes.CDLL(None, use_errno=True)
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    layout = struct.Struct('=12I16s32s6I2Q')

    def identity(pid):
        buf = ctypes.create_string_buffer(layout.size)
        if libproc.proc_pidinfo(pid, 3, 0, buf, layout.size) != layout.size:
            return None
        values = layout.unpack(buf.raw)
        if values[3] != pid or values[5] != os.getuid():
            return None
        return {'pid': pid, 'ppid': values[4], 'start': f'{values[-2]}:{values[-1]}'}

    requested = json.load(sys.stdin)
    if requested is None:
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
        if before is None:
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
    if metadata_reads == 0:
        raise ValueError('structured metadata unavailable')
    return result


try:
    print(json.dumps(snapshot()))
except Exception:
    # No argv, environment, or OS error payload may escape through diagnostics.
    sys.exit(1)
