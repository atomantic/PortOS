#!/usr/bin/env python3
"""Private Darwin archive backend. JSON-line stdin/stdout; service owns authority.

Never deletes original checkouts or Git administration. A move is one reversible
RENAME_EXCL; the caller must journal and fence each half of the transaction.
"""
import base64
import binascii
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import uuid

MAX_FILES = 200000
MAX_BYTES = 20 * 1024 ** 3
COMMON_PARTS = ('HEAD', 'objects', 'refs', 'logs', 'packed-refs', 'config', 'info',
                'description', 'hooks', 'rr-cache')
OPERATIONS = ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
              'rebase-merge', 'rebase-apply', 'sequencer', 'shallow')


def fail(reason):
    raise RuntimeError(reason)


def command(args, env=None, input_data=None, expected_returncode=0):
    result = subprocess.run(args, capture_output=True, text=True, env=env,
                            timeout=1200, **({'stdin': subprocess.DEVNULL} if input_data is None else {'input': input_data}))
    if result.returncode != expected_returncode:
        fail('command-failed:' + str(args[0]) + ':' + result.stderr[-1200:])
    return result.stdout


def git(admin, work, *args, objects=None, input_data=None, expected_returncode=0):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0',
               GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1')
    # Relocated linked-worktree administration must never silently use a common
    # or empty index during the standalone object-closure proof.
    env['GIT_INDEX_FILE'] = str(admin / 'index')
    if objects is not None:
        # Prove the isolated restore's complete refs/index against current live
        # objects without rewriting either its pointers or the original store.
        env['GIT_OBJECT_DIRECTORY'] = str(objects)
    return command(['git', '--no-optional-locks', '--git-dir', str(admin),
                    '--work-tree', str(work), '-c', 'core.fsmonitor=false',
                    '-c', 'core.hooksPath=' + os.devnull, *args], env, input_data,
                   expected_returncode=expected_returncode).strip()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def sha(path):
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            fail('not-regular-file')
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def acl(path):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.acl_get_link_np.argtypes = [ctypes.c_char_p, ctypes.c_int]
    libc.acl_get_link_np.restype = ctypes.c_void_p
    libc.acl_to_text.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ssize_t)]
    libc.acl_to_text.restype = ctypes.c_void_p
    libc.acl_free.argtypes = [ctypes.c_void_p]
    value = libc.acl_get_link_np(os.fsencode(path), 0x100)
    if not value:
        # Darwin returns ENOENT when the extended ACL itself is absent. The
        # surrounding lstat lease separately proves the filesystem entry exists.
        if ctypes.get_errno() == errno.ENOENT:
            path.lstat()
            return ''
        raise OSError(ctypes.get_errno(), 'cannot-read-acl')
    text = None
    try:
        length = ctypes.c_ssize_t()
        text = libc.acl_to_text(value, ctypes.byref(length))
        if not text:
            raise OSError(ctypes.get_errno(), 'cannot-format-acl')
        return ctypes.string_at(text, length.value).decode('utf8')
    finally:
        if text:
            libc.acl_free(text)
        libc.acl_free(value)


def raw_xattrs(path):
    # Apple's system Python lacks os.listxattr. Use the read-only Darwin ABI
    # from sys/xattr.h, including resource/compression data and no symlink follow.
    libc = ctypes.CDLL(None, use_errno=True)
    libc.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
    libc.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                             ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
    libc.listxattr.restype = libc.getxattr.restype = ctypes.c_ssize_t
    options = 0x0001 | 0x0020  # XATTR_NOFOLLOW | XATTR_SHOWCOMPRESSION
    def read(call):
        size = call(None, 0)
        if size < 0:
            raise OSError(ctypes.get_errno(), 'Cannot read extended attributes')
        if size > 16 * 1024 * 1024:
            raise RuntimeError('Extended attribute exceeds verification budget')
        data = ctypes.create_string_buffer(size)
        count = call(data, size)
        if count != size:
            raise RuntimeError('Extended attribute changed during read')
        return data.raw[:size]
    names = read(lambda buffer, size: libc.listxattr(os.fsencode(path), buffer, size, options))
    return {os.fsdecode(name): read(lambda buffer, size: libc.getxattr(
                os.fsencode(path), name, buffer, size, 0, options))
            for name in sorted(filter(None, names.split(b'\0')))}



def safe_path(value, directory=True):
    if not isinstance(value, str) or not os.path.isabs(value) or os.path.normpath(value) != value:
        fail('path-must-be-canonical-absolute')
    path = Path(value)
    for component in [*reversed(path.parents), path]:
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode):
            fail('symlink-path-component')
    if directory and not path.is_dir():
        fail('path-not-directory')
    return path


def identity(path):
    info = path.lstat()
    return {'dev': info.st_dev, 'ino': info.st_ino,
            'birthtime': getattr(info, 'st_birthtime', None)}


def manifest(root, reject_links=False):
    rows, groups, counts = [], {}, {}
    size = 0
    def visit(path, relative):
        nonlocal size
        if len(rows) >= MAX_FILES:
            fail('file-budget-exceeded')
        before = path.lstat()
        row = {'path': relative, 'mode': stat.S_IMODE(before.st_mode),
               'uid': before.st_uid, 'gid': before.st_gid, 'mtimeNs': before.st_mtime_ns,
               'flags': before.st_flags, 'acl': acl(path),
               'xattrs': {k: hashlib.sha256(v).hexdigest() for k, v in raw_xattrs(path).items()},
               'filesystemIdentity': identity(path)}
        rows.append(row)
        if stat.S_ISLNK(before.st_mode):
            if reject_links:
                fail('git-administration-symlink')
            row.update(kind='symlink', target=os.readlink(path))
        elif stat.S_ISREG(before.st_mode):
            size += before.st_size
            if size > MAX_BYTES:
                fail('byte-budget-exceeded')
            row.update(kind='file', bytes=before.st_size, sha256=sha(path))
            if before.st_nlink > 1:
                key = (before.st_dev, before.st_ino)
                row['hardlinkGroup'] = groups.setdefault(key, relative)
                counts[key] = (counts.get(key, (0, 0))[0] + 1, before.st_nlink)
        elif stat.S_ISDIR(before.st_mode):
            row['kind'] = 'directory'
            for child in sorted(path.iterdir()):
                visit(child, f'{relative}/{child.name}' if relative else child.name)
        else:
            fail('special-file-unsupported')
        after = path.lstat()
        lease = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if lease(before) != lease(after):
            fail('source-changed-during-scan')
    visit(root, '')
    if any(count != links for count, links in counts.values()):
        fail('external-hardlink-unsupported')
    return sorted(rows, key=lambda r: r['path'])


def same_copy(actual, expected):
    portable = lambda rows: [{k: v for k, v in row.items() if k != 'filesystemIdentity'} for row in rows]
    return portable(actual) == portable(expected)


def provenance_value(encoded):
    """Decode only bounded canonical metadata evidence, never apply it to a file."""
    if not isinstance(encoded, str) or len(encoded) > 24 * 1024 ** 2:
        return None
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        return None
    if len(raw) > 16 * 1024 ** 2 or base64.b64encode(raw).decode('ascii') != encoded:
        return None
    return raw


def source_provenance(root, rows):
    """Save original preimages before copying, bound to the captured source hash."""
    originals, size = {}, 0
    for row in rows:
        expected = row['xattrs'].get('com.apple.provenance')
        if expected is None:
            continue
        raw = raw_xattrs(root / row['path']).get('com.apple.provenance')
        if raw is None or hashlib.sha256(raw).hexdigest() != expected:
            fail('source-provenance-changed')
        size += len(raw)
        if size > 16 * 1024 ** 2:
            fail('provenance-evidence-budget-exceeded')
        originals[row['path']] = base64.b64encode(raw).decode('ascii')
    return originals


def recorded_provenance(records):
    originals = {}
    for row in records:
        if 'originalBase64' not in row:
            continue
        values = row['originalBase64']
        if not isinstance(values, dict) or set(values) != {'com.apple.provenance'} or row['path'] in originals:
            fail('invalid-provenance-preimage-layout')
        originals[row['path']] = values['com.apple.provenance']
    return originals


def copy_augmentations(actual, expected, originals=None):
    """Record provenance additions, or v3 replacements with exact saved preimages."""
    if len(actual) != len(expected):
        return None
    additions = []
    for copied, source in zip(actual, expected):
        attrs = copied.get('xattrs', {})
        original = source.get('xattrs', {})
        extra = set(attrs) - set(original)
        if extra - {'com.apple.provenance'}:
            return None
        replaced = ('com.apple.provenance' in original and 'com.apple.provenance' in attrs
                    and original['com.apple.provenance'] != attrs['com.apple.provenance'])
        compared_attrs = {key: value for key, value in attrs.items() if key not in extra}
        if extra or replaced:
            value = attrs['com.apple.provenance']
            if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
                return None
            record = {'path': copied['path'], 'xattrs': {'com.apple.provenance': value}}
            if replaced:
                encoded = originals.get(source['path']) if originals is not None else None
                raw = provenance_value(encoded)
                if raw is None or hashlib.sha256(raw).hexdigest() != original['com.apple.provenance']:
                    return None
                record['originalBase64'] = {'com.apple.provenance': encoded}
                compared_attrs['com.apple.provenance'] = original['com.apple.provenance']
            additions.append(record)
        comparison = {**copied, 'xattrs': compared_attrs}
        if not same_copy([comparison], [source]):
            return None
    return additions


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_json(path, data):
    encoded = (json.dumps(data, sort_keys=True) + '\n').encode('utf-8')
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as out:
        out.write(encoded)
        out.flush()
        os.fsync(out.fileno())
    fsync_dir(path.parent)
    return hashlib.sha256(encoded).hexdigest()


def read_pointer(path, prefix='', directory=True):
    if not stat.S_ISREG(path.lstat().st_mode):
        fail('git-pointer-not-regular')
    if path.stat().st_size > 16384:
        fail('git-pointer-too-large')
    raw = path.read_text().strip()
    if prefix:
        if not raw.startswith(prefix):
            fail('invalid-git-pointer')
        raw = raw[len(prefix):].strip()
    return safe_path(os.path.abspath(path.parent / raw), directory=directory)


def checked_config(admin):
    for name in ['config', 'config.worktree']:
        path = admin / name
        if not path.exists():
            continue
        text = command(['git', 'config', '--no-includes', '--file', str(path), '--list'])
        for line in text.splitlines():
            key = line.split('=', 1)[0].lower()
            if key.startswith(('include.', 'includeif.')) or key.endswith('.promisor') or key == 'extensions.partialclone':
                fail('external-git-configuration')
            if key.startswith('extensions.') and key not in ('extensions.objectformat', 'extensions.worktreeconfig'):
                fail('unknown-git-extension')


def check_admin(admin, module=False, common=False):
    if any((admin / name).exists() for name in OPERATIONS):
        fail('active-or-partial-git-state')
    for name in ('objects/info/alternates', 'objects/info/http-alternates', 'info/grafts'):
        if (admin / name).exists():
            fail('external-object-dependency')
    if module and any((admin / name).exists() for name in ('commondir', 'worktrees', 'modules')):
        fail('shared-or-nested-module')
    # Shared capture includes only COMMON_PARTS. Primary-checkout modules and
    # runtime sockets remain live outside it; private module administration is
    # captured in full and must still reject every special file. Root locks and
    # operation/config/object dependencies remain guards even outside the copy.
    for current, dirs, files in os.walk(admin, followlinks=False):
        if Path(current) == admin and common:
            if any(name.endswith(('.lock', '.promisor')) or name.startswith('sharedindex.')
                   for name in [*dirs, *files]):
                fail('active-or-dependent-git-state')
            dirs[:] = [name for name in dirs if name in COMMON_PARTS]
            files = [name for name in files if name in COMMON_PARTS]
        elif Path(current) == admin and not module:
            dirs[:] = [d for d in dirs if d not in ('worktrees', 'portos-checkout-admission')]
        for name in [*dirs, *files]:
            path = Path(current) / name
            if path.is_symlink():
                fail('git-administration-symlink')
            mode = path.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                fail('special-git-file-unsupported')
            if name.endswith(('.lock', '.promisor')) or name.startswith('sharedindex.'):
                fail('active-or-dependent-git-state')
    checked_config(admin)


def git_facts(admin, work):
    stage = git(admin, work, 'ls-files', '--stage', '-z')
    # Split indexes may reference a sharedindex outside this private store.
    if git(admin, work, 'rev-parse', '--shared-index-path'):
        fail('split-index-unsupported')
    return {'head': git(admin, work, 'rev-parse', '--verify', 'HEAD^{commit}'),
            'indexSha256': sha(admin / 'index'), 'stageSha256': hashlib.sha256(stage.encode()).hexdigest(),
            'refs': git(admin, work, 'for-each-ref', '--format=%(refname) %(objectname)')}


def prove_index_blobs(admin, work, objects=None):
    # fsck can return success for a missing staged-only blob. Enumerate every
    # index stage explicitly, excluding gitlinks whose objects belong to modules.
    oids = set()
    for row in git(admin, work, 'ls-files', '--stage', '-z').split('\0'):
        if not row:
            continue
        mode, oid, _ = row.split('\t', 1)[0].split()
        if mode == '160000':
            continue
        if mode not in ('100644', '100755', '120000') or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', oid):
            fail('unsupported-index-entry')
        oids.add(oid)
        if len(oids) > MAX_FILES:
            fail('index-object-budget-exceeded')
    if not oids:
        return
    expected = sorted(oids)
    lines = git(admin, work, 'cat-file', '--batch-check', objects=objects,
                input_data='\n'.join(expected) + '\n').splitlines()
    if len(lines) != len(expected):
        fail('index-object-proof-incomplete')
    for oid, line in zip(expected, lines):
        fields = line.split()
        if len(fields) != 3 or fields[0] != oid or fields[1] != 'blob' or not fields[2].isdigit():
            fail('missing-or-invalid-index-object')


def scan(request):
    release = request['release']
    work = safe_path(release['path'])
    repo = safe_path(request['repoPath'])
    admin = read_pointer(work / '.git', 'gitdir:')
    common = read_pointer(admin / 'commondir')
    if admin.parent != common / 'worktrees' or work == repo:
        fail('not-private-linked-checkout')
    repo_admin = repo / '.git'
    if not repo_admin.is_dir():
        repo_admin = read_pointer(repo_admin, 'gitdir:')
    repo_common = read_pointer(repo_admin / 'commondir') if (repo_admin / 'commondir').exists() else safe_path(str(repo_admin))
    if common != repo_common:
        fail('repository-binding-mismatch')
    if read_pointer(admin / 'gitdir', directory=False) != work / '.git':
        # gitdir points to .git (a file), handled explicitly below.
        fail('administration-backlink-mismatch')
    return work, admin, common


def copy_tree(source, destination):
    if destination.exists() or destination.is_symlink():
        raise RuntimeError('Destination exists; never overwrite recovery evidence')
    env = {k: v for k, v in os.environ.items() if not k.startswith('DITTO')}
    env['DITTOABORT'] = '1'
    command(['/usr/bin/ditto', '--rsrc', '--extattr', '--acl', '--qtn',
             str(source), str(destination)], env)
    # ditto and clonefile omit residual decmpfs attributes when UF_COMPRESSED
    # is unset. Preserve those exact bytes on the NEW copy only. Never install
    # compression metadata onto an actually compressed file by this mechanism.
    candidates = [source] if source.is_file() else source.rglob('*')
    for original in candidates:
        if not stat.S_ISREG(original.lstat().st_mode):
            continue
        target = destination if original == source else destination / original.relative_to(source)
        attributes = raw_xattrs(original)
        name = 'com.apple.decmpfs'
        if name not in attributes or name in raw_xattrs(target):
            continue
        if original.lstat().st_flags & 0x20 or target.lstat().st_flags & 0x20:
            raise RuntimeError('Compressed file metadata requires separate preservation review')
        if not stat.S_ISREG(target.lstat().st_mode) or sha(original) != sha(target):
            raise RuntimeError('Cannot restore residual metadata onto a different file')
        libc = ctypes.CDLL(None, use_errno=True)
        libc.setxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                                 ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
        libc.setxattr.restype = ctypes.c_int
        value = attributes[name]
        buffer = ctypes.create_string_buffer(value)
        if libc.setxattr(os.fsencode(target), name.encode(), buffer, len(value), 0,
                         0x0001 | 0x0002):  # XATTR_NOFOLLOW | XATTR_CREATE
            raise OSError(ctypes.get_errno(), 'Cannot preserve residual compression metadata')
    # ditto also omits UF_TRACKED, which the filesystem may add later while
    # verification reads the copy. Set the exact original flags before reading;
    # retain strict flags and source-incarnation comparisons in the manifests.
    for original in [source, *source.rglob('*')] if source.is_dir() else [source]:
        target = destination if original == source else destination / original.relative_to(source)
        original_stat = original.lstat()
        # ditto creates symlinks with the current timestamp. Restore the link's
        # own timestamps without resolving even a dangling dependency target.
        if stat.S_ISLNK(original_stat.st_mode):
            os.utime(target, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
                     follow_symlinks=False)
        expected_flags = original_stat.st_flags
        actual_flags = target.lstat().st_flags
        if (expected_flags ^ actual_flags) & 0x20:
            raise RuntimeError('Compression flags differ; cannot synthesize compressed storage')
        if expected_flags != actual_flags:
            os.chflags(target, expected_flags, follow_symlinks=False)



def inspect(request, full=False):
    if sys.platform != 'darwin':
        fail('darwin-required')
    work, admin, common = scan(request)
    release = request['release']
    check_admin(admin)
    check_admin(common, common=True)
    parent = git_facts(admin, work)
    branch = git(admin, work, 'symbolic-ref', '--short', 'HEAD')
    if parent['head'] != release['head'] or branch != release['branch']:
        fail('release-head-or-branch-changed')
    lock = admin / 'locked'
    locked = lock.exists()
    if locked != release['locked']:
        fail('release-lock-changed')
    if locked and lock.read_text().strip() != (release.get('lockReason') or ''):
        fail('release-lock-reason-changed')
    modules = []
    for item in git(admin, work, 'ls-files', '--stage', '-z').split('\0'):
        if not item:
            continue
        fields, relative = item.split('\t', 1)
        mode, oid, stage = fields.split()
        if mode != '160000':
            continue
        if stage != '0' or os.path.isabs(relative) or '..' in Path(relative).parts:
            fail('unmerged-or-unsafe-module')
        module_work = safe_path(str(work / relative))
        module_admin = read_pointer(module_work / '.git', 'gitdir:')
        if not module_admin.is_relative_to(admin / 'modules'):
            fail('external-module-administration')
        check_admin(module_admin, module=True)
        facts = git_facts(module_admin, module_work)
        if any(row.startswith('160000 ') for row in git(module_admin, module_work, 'ls-files', '--stage', '-z').split('\0')):
            fail('nested-module-unsupported')
        modules.append({'path': relative, 'gitDir': str(module_admin),
                        'administrationPath': str(module_admin.relative_to(admin)),
                        'identity': {'working': identity(module_work), 'administration': identity(module_admin)},
                        'gitlink': oid, **facts})
    if not modules:
        fail('initialized-module-required')
    expected_pointers = {'.git', *(m['path'] + '/.git' for m in modules)}
    for current, dirs, files in os.walk(work, followlinks=False):
        if '.git' in dirs:
            fail('embedded-git-store-unsupported')
        if '.git' in files and str((Path(current) / '.git').relative_to(work)) not in expected_pointers:
            fail('unregistered-git-pointer')
    if (admin / 'modules').exists():
        allowed_admin = {m['gitDir'] for m in modules}
        for current, _, files in os.walk(admin / 'modules', followlinks=False):
            if 'HEAD' in files and 'config' in files and str(Path(current)) not in allowed_admin:
                fail('unregistered-private-module')
    sources = {'working': manifest(work), 'administration': manifest(admin, True),
               'common': {name: manifest(common / name, True) for name in COMMON_PARTS if (common / name).exists()}}
    facts = {'identity': {'working': identity(work), 'administration': identity(admin), 'common': identity(common)},
             'privateGitDir': str(admin), 'commonGitDir': str(common), 'modules': modules, 'parent': parent,
             'repoPath': request['repoPath'], 'release': release}
    facts['administrationFingerprint'] = digest(sources['administration'])
    facts['fingerprint'] = digest({'facts': facts, 'sources': sources})
    return {**facts, **({'sources': sources} if full else {})}


def transaction(value):
    root = safe_path(value)
    info = root.stat()
    if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
        fail('transaction-must-be-owned-private0700')
    return root


def lock_file(root, name):
    fd = os.open(root / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
        os.close(fd)
        fail('invalid-execution-lock')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        fail('backend-busy')
    return fd


def rewrite_copy(path, text):
    # Only isolated proof pointers are rewritten; archive pointer bytes remain exact.
    if not stat.S_ISREG(path.lstat().st_mode):
        fail('restore-pointer-not-regular')
    with path.open('wb') as out:
        out.write(text.encode('utf-8') if isinstance(text, str) else text)
        out.flush()
        os.fsync(out.fileno())


def proof_repositories(root, facts):
    restore = root / 'restore'
    work, admin, common = restore / 'working', restore / 'administration', restore / 'common'
    if read_pointer(work / '.git', 'gitdir:') != admin or read_pointer(admin / 'commondir') != common:
        fail('restore-parent-pointer-escaped')
    if read_pointer(admin / 'gitdir', directory=False) != work / '.git':
        fail('restore-backlink-escaped')
    results = []
    for label, store, tree, expected in [('parent', admin, work, facts['parent']), *[
        (m['path'], admin / m['administrationPath'], work / m['path'], m) for m in facts['modules']
    ]]:
        if label != 'parent' and read_pointer(tree / '.git', 'gitdir:') != store:
            fail('restore-module-pointer-escaped')
        check_admin(store, module=label != 'parent')
        actual = git_facts(store, tree)
        if any(actual[k] != expected[k] for k in ('head', 'indexSha256', 'stageSha256', 'refs')):
            fail('restored-git-facts-differ')
        # fsck validates loose/packed objects and ref closure; indexed blobs get
        # a separate existence proof below. No checkout, hooks or lost-found.
        git(store, tree, 'fsck', '--full', '--strict')
        prove_index_blobs(store, tree)
        results.append({'path': label, **actual, 'fsck': 'passed'})
    return results


def durable_tree(root):
    """Flush only owned copies before the journal may authorize a rename."""
    directories = []
    for current, dirs, files in os.walk(root, followlinks=False):
        directories.append(Path(current))
        dirs[:] = [name for name in dirs if not (Path(current) / name).is_symlink()]
        for name in files:
            path = Path(current) / name
            if path.is_symlink():
                continue
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    for directory in reversed(directories):
        fsync_dir(directory)


def preserve(request):
    root = transaction(request['transactionDir'])
    before = inspect(request, full=True)
    expected = request['expected']
    if any(before[k] != expected.get(k) for k in ('fingerprint', 'administrationFingerprint', 'identity')):
        fail('inspection-changed')
    work, admin, common = Path(before['release']['path']), Path(before['privateGitDir']), Path(before['commonGitDir'])
    for source in (work, admin, common):
        if root.is_relative_to(source) or source.is_relative_to(root):
            fail('transaction-source-overlap')
        if root.stat().st_dev != source.stat().st_dev:
            fail('quarantine-cross-device')
    rows = before['sources']['working'] + before['sources']['administration']
    rows += [r for section in before['sources']['common'].values() for r in section]
    size = sum(r.get('bytes', 0) for r in rows)
    if size > MAX_BYTES or shutil.disk_usage(root).free < size * 2 + 1024 ** 3:
        fail('insufficient-preservation-space')
    for name in ('archive', 'restore', 'quarantine'):
        if os.path.lexists(root / name):
            fail('backend-destination-already-exists')
    if os.path.lexists(root / 'manifest.json'):
        fail('backend-manifest-already-exists')
    for name in ('archive', 'restore', 'quarantine'):
        (root / name).mkdir(mode=0o700)
    # Persist the complete source evidence before copying. Failure leaves a
    # recognizable incomplete archive; retry never overwrites any part.
    private_json(root / 'source.json', before)
    augmentations = {'archive': {'common': {}}, 'restore': {}}
    for label, source in [('working', work), ('administration', admin)]:
        originals = source_provenance(source, before['sources'][label])
        copy_tree(source, root / 'archive' / label)
        added = copy_augmentations(manifest(root / 'archive' / label), before['sources'][label], originals)
        if added is None:
            fail('archive-metadata-mismatch:' + label)
        augmentations['archive'][label] = added
    (root / 'archive' / 'common').mkdir(mode=0o700)
    for name, expected_rows in before['sources']['common'].items():
        originals = source_provenance(common / name, expected_rows)
        copy_tree(common / name, root / 'archive' / 'common' / name)
        added = copy_augmentations(manifest(root / 'archive' / 'common' / name, True), expected_rows, originals)
        if added is None:
            fail('shared-archive-metadata-mismatch:' + name)
        augmentations['archive']['common'][name] = added
    for label in ('working', 'administration', 'common'):
        archived = manifest(root / 'archive' / label)
        originals = source_provenance(root / 'archive' / label, archived)
        copy_tree(root / 'archive' / label, root / 'restore' / label)
        added = copy_augmentations(manifest(root / 'restore' / label), archived, originals)
        if added is None:
            fail('restore-copy-metadata-mismatch')
        # Historical pre-relocation evidence; saved.restored below is the exact
        # post-relocation expectation used by every later restore verification.
        augmentations['restore'][label] = added
    restore = root / 'restore'
    rewrite_copy(restore / 'working' / '.git', 'gitdir: ' + str(restore / 'administration') + '\n')
    rewrite_copy(restore / 'administration' / 'commondir', str(restore / 'common') + '\n')
    rewrite_copy(restore / 'administration' / 'gitdir', str(restore / 'working' / '.git') + '\n')
    for m in before['modules']:
        store, tree = restore / 'administration' / m['administrationPath'], restore / 'working' / m['path']
        rewrite_copy(tree / '.git', 'gitdir: ' + str(store) + '\n')
        # Git config publishes through lock/rename, which can discard inherited
        # xattrs. Generate only replacement bytes outside the proof tree, then
        # rewrite the isolated config in place without changing its metadata.
        scratch = root / 'relocated-module-config'
        with os.fdopen(os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as out:
            out.write((store / 'config').read_bytes())
        git(store, tree, 'config', '--file', str(scratch), 'core.worktree', str(tree))
        rewrite_copy(store / 'config', scratch.read_bytes())
        scratch.unlink()
    proof = proof_repositories(root, before)
    # Check source metadata again after both full copies and offline proof.
    after = inspect(request, full=True)
    if before != after:
        fail('sources-changed-during-preservation')
    restored = {label: manifest(restore / label) for label in ('working', 'administration', 'common')}
    durable_tree(root / 'archive')
    durable_tree(restore)
    saved = {'version': 3, 'transactionIdentity': identity(root), 'facts': before,
             'copyAugmentations': augmentations, 'restored': restored, 'restoreProof': proof}
    check_restore_augmentations(root, saved)
    manifest_sha = private_json(root / 'manifest.json', saved)
    return {'manifestSha256': manifest_sha, 'manifestPath': str(root / 'manifest.json'), 'fingerprint': before['fingerprint'],
            'administrationFingerprint': before['administrationFingerprint'], 'restoreProof': proof}


def verify_unmoved_preservation(request):
    """Cancel an unbound copy while shared Git evolves; never move any data."""
    root = transaction(request['transactionDir'])
    if os.path.lexists(root / 'manifest.json'):
        fail('preservation-already-bound')
    quarantine = root / 'quarantine'
    if os.path.lexists(quarantine) and (not safe_path(str(quarantine)).is_dir()
                                       or any(quarantine.iterdir())):
        fail('preservation-originals-may-have-moved')
    path = root / 'source.json'
    limit = 256 * 1024 ** 2
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            fail('invalid-preservation-source')
        encoded = source.read(limit + 1)
    if len(encoded) > limit:
        fail('invalid-preservation-source')
    before = json.loads(encoded)
    compact = {k: v for k, v in before.items() if k != 'sources'}
    expected = {k: v for k, v in request['expected'].items() if k != 'ok'}
    if compact != expected:
        fail('preservation-source-not-reviewed')
    unsigned = {k: v for k, v in compact.items() if k != 'fingerprint'}
    if digest({'facts': unsigned, 'sources': before['sources']}) != before['fingerprint']:
        fail('preservation-source-proof-changed')
    after = inspect(request, full=True)
    def stable_facts(value):
        facts = {k: v for k, v in value.items() if k not in ('sources', 'fingerprint')}
        # Other checkouts publish shared refs. Their history is not being
        # retired here. inspect still resolves this exact released branch/head;
        # private refs are also covered byte-for-byte by administration below.
        facts['parent'] = {k: v for k, v in facts['parent'].items() if k != 'refs'}
        return facts
    if stable_facts(before) != stable_facts(after):
        fail('preservation-original-identity-or-git-changed')
    for part in ('working', 'administration'):
        if before['sources'][part] != after['sources'][part]:
            fail('preservation-original-content-changed')
    # No shared data is restored, removed, or certified as archived. Preserve
    # both observation hashes so cancellation cannot masquerade as retirement.
    return {'verified': True, 'originalsUnmoved': True, 'archiveVerified': False,
            'sharedBeforeSha256': digest(before['sources']['common']),
            'sharedAfterSha256': digest(after['sources']['common']),
            'sourceSha256': hashlib.sha256(encoded).hexdigest(),
            'reviewedFingerprint': before['fingerprint'], 'observedFingerprint': after['fingerprint']}


def load_transaction(request):
    root = transaction(request['transactionDir'])
    path = root / 'manifest.json'
    limit = 256 * 1024 ** 2
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            fail('invalid-archive-manifest')
        encoded = source.read(limit + 1)
    if len(encoded) > limit:
        fail('invalid-archive-manifest')
    saved = json.loads(encoded)
    if saved['version'] not in (1, 2, 3) or saved['transactionIdentity'] != identity(root):
        fail('transaction-incarnation-changed')
    # A bound v2 archive cannot evade its journal proof by declaring itself v1.
    # Hash the exact bytes parsed, never a second path read after parsing.
    if (saved['version'] >= 2 or 'manifestSha256' in request) and request.get('manifestSha256') != hashlib.sha256(encoded).hexdigest():
        fail('archive-manifest-proof-changed')
    for label in ('archive', 'restore', 'quarantine'):
        safe_path(str(root / label))
    return root, saved


def placements(root, facts):
    result = {}
    for label, source in [('working', facts['release']['path']), ('administration', facts['privateGitDir'])]:
        original, quarantine = Path(source), root / 'quarantine' / label
        result[label] = {}
        for name, path in [('original', original), ('quarantine', quarantine)]:
            if not os.path.lexists(path):
                result[label][name] = 'absent'
            else:
                safe_path(str(path))
                result[label][name] = 'matching' if identity(path) == facts['identity'][label] else 'foreign'
        positions = result[label]
        positions['state'] = ('original' if positions == {'original': 'matching', 'quarantine': 'absent'}
                              else 'quarantine' if positions == {'original': 'absent', 'quarantine': 'matching'}
                              else 'ambiguous')
    return result


def check_restore_augmentations(root, saved):
    if saved['version'] == 1:
        return
    records = saved['copyAugmentations']
    if (set(records) != {'archive', 'restore'}
            or set(records['archive']) != {'working', 'administration', 'common'}
            or set(records['archive']['common']) != set(saved['facts']['sources']['common'])
            or set(records['restore']) != {'working', 'administration', 'common'}):
        fail('invalid-copy-augmentation-layout')
    for label in ('working', 'administration', 'common'):
        archived = manifest(root / 'archive' / label)
        attrs = lambda rows: [{'path': row['path'], 'xattrs': row['xattrs']} for row in rows]
        originals = recorded_provenance(records['restore'][label]) if saved['version'] == 3 else None
        added = copy_augmentations(attrs(saved['restored'][label]), attrs(archived), originals)
        if added is None or added != records['restore'][label]:
            fail('restore-copy-augmentation-changed:' + label)


def verify_saved_archive(root, saved):
    check_restore_augmentations(root, saved)
    facts = saved['facts']
    recorded = saved['copyAugmentations']['archive'] if saved['version'] >= 2 else None
    for label in ('working', 'administration'):
        expected_added = recorded[label] if recorded is not None else []
        originals = recorded_provenance(expected_added) if saved['version'] == 3 else None
        added = copy_augmentations(manifest(root / 'archive' / label), facts['sources'][label], originals)
        if added is None or added != expected_added:
            fail('archive-changed:' + label)
    for name, expected in facts['sources']['common'].items():
        expected_added = recorded['common'][name] if recorded is not None else []
        originals = recorded_provenance(expected_added) if saved['version'] == 3 else None
        added = copy_augmentations(manifest(root / 'archive' / 'common' / name, True), expected, originals)
        if added is None or added != expected_added:
            fail('common-archive-changed:' + name)
    if sorted(p.name for p in (root / 'archive/common').iterdir()) != sorted(facts['sources']['common']):
        fail('common-archive-layout-changed')
    for label, expected in saved['restored'].items():
        if manifest(root / 'restore' / label) != expected:
            fail('restore-proof-changed:' + label)
    return proof_repositories(root, facts)


def original_sources(root, facts):
    located = placements(root, facts)
    sources = {}
    for label in ('working', 'administration'):
        state = located[label]['state']
        if state == 'ambiguous':
            fail('ambiguous-source-placement:' + label)
        original = facts['release']['path'] if label == 'working' else facts['privateGitDir']
        path = Path(original) if state == 'original' else root / 'quarantine' / label
        sources[label] = manifest(path)
    return located, sources


def metadata_recovery_changes(root, saved, located, sources):
    """Prove only the observed, reversible-rename metadata differences.

    Removed residual compression bytes remain in the verified archive. No
    attribute is installed on an original, and all non-attribute fields,
    including filesystem identity and UF_COMPRESSED, remain exact.
    """
    changes, total = [], 0
    for label in ('working', 'administration'):
        expected, actual = saved['facts']['sources'][label], sources[label]
        if len(expected) != len(actual):
            fail('metadata-recovery-source-layout-changed:' + label)
        original = saved['facts']['release']['path'] if label == 'working' else saved['facts']['privateGitDir']
        current = Path(original) if located[label]['state'] == 'original' else root / 'quarantine' / label
        for before, after in zip(expected, actual):
            if {k: v for k, v in before.items() if k != 'xattrs'} != {
                    k: v for k, v in after.items() if k != 'xattrs'}:
                fail('metadata-recovery-source-content-or-identity-changed:' + label)
            old, new = before['xattrs'], after['xattrs']
            for name in sorted(set(old) | set(new)):
                if old.get(name) == new.get(name):
                    continue
                change = {'part': label, 'path': before['path'], 'attribute': name,
                          'beforeSha256': old.get(name), 'afterSha256': new.get(name)}
                if (name == 'com.apple.decmpfs' and name in old and name not in new
                        and before['kind'] == 'file' and not before['flags'] & 0x20):
                    raw = raw_xattrs(root / 'archive' / label / before['path']).get(name)
                    if raw is None or hashlib.sha256(raw).hexdigest() != old[name]:
                        fail('metadata-recovery-preimage-missing-or-changed')
                    change['beforeBase64'] = base64.b64encode(raw).decode('ascii')
                elif (name == 'com.apple.provenance' and name not in old and name in new
                      and before['path'] == '' and before['kind'] == 'directory'):
                    raw = raw_xattrs(current).get(name)
                    if raw is None or hashlib.sha256(raw).hexdigest() != new[name]:
                        fail('metadata-recovery-observation-changed')
                    change['afterBase64'] = base64.b64encode(raw).decode('ascii')
                else:
                    fail('metadata-recovery-unsupported-attribute-change:' + label + ':' + name)
                total += len(raw)
                if total > 16 * 1024 ** 2:
                    fail('metadata-recovery-evidence-budget-exceeded')
                changes.append(change)
    return changes


def immutable_recovery_evidence(root, prefix, evidence):
    value = digest(evidence)
    name = prefix + value + '.json'
    path = root / name
    encoded = (json.dumps(evidence, sort_keys=True) + '\n').encode('utf-8')
    if len(encoded) > 256 * 1024 ** 2:
        fail('metadata-recovery-evidence-budget-exceeded')
    def existing_matches():
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid()
                    or info.st_size != len(encoded) or source.read(len(encoded) + 1) != encoded):
                fail('metadata-recovery-evidence-changed')
    if os.path.lexists(path):
        existing_matches()
    else:
        # A stopped write must not occupy the deterministic proof name. Keep
        # abandoned staging files as evidence; only a fully fsynced record may
        # become canonical, with no replacement of an existing destination.
        staged = root / ('.' + name + '.' + uuid.uuid4().hex + '.staging')
        private_json(staged, evidence)
        try:
            exclusive_rename(staged, path)
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise
            existing_matches()
        fsync_dir(root)
    return {'file': name, 'sha256': hashlib.sha256(encoded).hexdigest(), 'digest': value}


def load_metadata_recovery(root, saved, request):
    accepted = request['metadataRecovery']
    if (not isinstance(accepted, dict)
            or set(accepted) != {'version', 'evidenceFile', 'evidenceSha256', 'digest'}
            or accepted['version'] != 1
            or not isinstance(accepted['digest'], str)
            or not re.fullmatch(r'[0-9a-f]{64}', accepted['digest'])
            or accepted['evidenceFile'] != 'metadata-recovery-' + accepted['digest'] + '.json'):
        fail('metadata-recovery-proof-invalid')
    path = root / accepted['evidenceFile']
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid()
                or info.st_size > 256 * 1024 ** 2):
            fail('metadata-recovery-evidence-unsafe')
        encoded = source.read(256 * 1024 ** 2 + 1)
    if hashlib.sha256(encoded).hexdigest() != accepted['evidenceSha256']:
        fail('metadata-recovery-evidence-changed')
    evidence = json.loads(encoded)
    if (digest(evidence) != accepted['digest']
            or set(evidence) != {'version', 'manifestSha256', 'transactionIdentity',
                                 'originalFingerprint', 'initialPlacements', 'sources', 'changes'}
            or evidence['version'] != 1
            or evidence['manifestSha256'] != request.get('manifestSha256')
            or evidence['transactionIdentity'] != saved['transactionIdentity']
            or evidence['originalFingerprint'] != saved['facts']['fingerprint']
            or set(evidence['initialPlacements']) != {'working', 'administration'}
            or any(value not in ('original', 'quarantine') for value in evidence['initialPlacements'].values())):
        fail('metadata-recovery-proof-invalid')
    return evidence


def verify_metadata_recovery(root, saved, request, located, sources):
    evidence = load_metadata_recovery(root, saved, request)
    if sources != evidence['sources']:
        fail('metadata-recovery-review-changed')
    for label in ('working', 'administration'):
        # A restoration can only advance toward original placement. The outer
        # service additionally binds the initial placement to its journal step.
        if located[label]['state'] not in (evidence['initialPlacements'][label], 'original'):
            fail('metadata-recovery-placement-regressed')
    if metadata_recovery_changes(root, saved, located, sources) != evidence['changes']:
        fail('metadata-recovery-review-changed')


def review_metadata_recovery(request):
    if not re.fullmatch(r'[0-9a-f]{64}', request.get('manifestSha256', '')):
        fail('metadata-recovery-manifest-proof-required')
    root, saved = load_transaction(request)
    verify_saved_archive(root, saved)
    located, sources = original_sources(root, saved['facts'])
    changes = metadata_recovery_changes(root, saved, located, sources)
    verify_live_common(root, saved, restoring=True)
    if original_sources(root, saved['facts']) != (located, sources):
        fail('metadata-recovery-observation-changed')
    evidence = {'version': 1, 'manifestSha256': request['manifestSha256'],
                'transactionIdentity': saved['transactionIdentity'],
                'originalFingerprint': saved['facts']['fingerprint'],
                'initialPlacements': {label: row['state'] for label, row in located.items()},
                'sources': sources, 'changes': changes}
    stored = immutable_recovery_evidence(root, 'metadata-recovery-', evidence)
    return {'metadataRecovery': {'version': 1, 'evidenceFile': stored['file'],
                                'evidenceSha256': stored['sha256'], 'digest': stored['digest']},
            'initialPlacements': evidence['initialPlacements'],
            'changeCounts': {'residualCompressionRemoved': sum(row['attribute'] == 'com.apple.decmpfs' for row in changes),
                             'rootProvenanceAdded': sum(row['attribute'] == 'com.apple.provenance' for row in changes)},
            'changedPaths': len({(row['part'], row['path']) for row in changes})}


def load_bound_evidence(root, reference, prefix, reason='restored-finalization'):
    if (not isinstance(reference, dict) or set(reference) != {'file', 'sha256', 'digest'}
            or not isinstance(reference['digest'], str)
            or not re.fullmatch(r'[0-9a-f]{64}', reference['digest'])
            or reference['file'] != prefix + reference['digest'] + '.json'):
        fail(reason + '-evidence-invalid')
    path = root / reference['file']
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid()
                or info.st_size > 256 * 1024 ** 2):
            fail(reason + '-evidence-unsafe')
        encoded = source.read(256 * 1024 ** 2 + 1)
    evidence = json.loads(encoded)
    # All supported publishers use this canonical encoding. Exact equality also
    # rejects duplicate JSON keys rather than interpreting an ambiguous ledger.
    if (hashlib.sha256(encoded).hexdigest() != reference['sha256']
            or digest(evidence) != reference['digest']
            or encoded != (json.dumps(evidence, sort_keys=True) + '\n').encode('utf-8')):
        fail(reason + '-evidence-changed')
    return evidence


def restored_finalization_context(root, saved, request):
    prior = load_metadata_recovery(root, saved, request)
    accepted = request['metadataRecovery']
    canonical_prior = load_bound_evidence(root, {
        'file': accepted['evidenceFile'], 'sha256': accepted['evidenceSha256'],
        'digest': accepted['digest']}, 'metadata-recovery-')
    if canonical_prior != prior:
        fail('restored-finalization-prior-review-changed')
    located, sources = original_sources(root, saved['facts'])
    if any(row['state'] != 'original' for row in located.values()):
        fail('restored-finalization-original-placement-required')
    if metadata_recovery_changes(root, saved, located, prior['sources']) != prior['changes']:
        fail('restored-finalization-prior-review-changed')
    references = request.get('postMoveObservations')
    if not isinstance(references, list) or len(references) != 2:
        fail('restored-finalization-postmove-proof-required')
    for part, reference in zip(('administration', 'working'), references):
        # An already-original administration restore is an authenticated no-op,
        # so the old move command legitimately produced no postmove artifact.
        if (reference is None and part == 'administration'
                and prior['initialPlacements'][part] == 'original'
                and sources[part] == saved['facts']['sources'][part]):
            continue
        observation = load_bound_evidence(root, reference, 'metadata-recovery-postmove-')
        positions = {
            label: {'original': 'matching' if state == 'original' else 'absent',
                    'quarantine': 'absent' if state == 'original' else 'matching', 'state': state}
            for label, state in {'administration': 'original',
                                 'working': 'original' if part == 'working' else 'quarantine'}.items()}
        if observation != {'version': 1, 'manifestSha256': request['manifestSha256'],
                           'acceptedMetadataRecovery': accepted, 'part': part,
                           'placements': positions, 'sources': prior['sources']}:
            fail('restored-finalization-postmove-proof-changed')
    return prior, located, sources


def restored_finalization_changes(root, saved, prior, sources):
    # This is a record-only acceptance after both moves, never a move policy.
    # Directory mtimes are evidence of an observed change, not a causal claim.
    baseline = saved['facts']['sources']
    if sources['administration'] != baseline['administration']:
        fail('restored-finalization-administration-changed')
    expected, actual = prior['sources']['working'], sources['working']
    if len(expected) != len(actual):
        fail('restored-finalization-source-layout-changed')
    preimages = {(row['part'], row['path'], row['attribute']): row for row in prior['changes']}
    changes, total = [], 0
    for original, before, after in zip(baseline['working'], expected, actual):
        excluded = {'xattrs', 'mtimeNs'} if before['kind'] == 'directory' else {'xattrs'}
        if {k: v for k, v in before.items() if k not in excluded} != {
                k: v for k, v in after.items() if k not in excluded}:
            fail('restored-finalization-source-content-or-identity-changed')
        if before['mtimeNs'] != after['mtimeNs']:
            changes.append({'part': 'working', 'path': before['path'], 'field': 'mtimeNs',
                            'before': before['mtimeNs'], 'after': after['mtimeNs']})
        for name in sorted(set(before['xattrs']) | set(after['xattrs'])):
            old, new = before['xattrs'].get(name), after['xattrs'].get(name)
            if old == new:
                continue
            preimage = preimages.get(('working', before['path'], name), {})
            if (name != 'com.apple.decmpfs' or old is not None or new is None
                    or before['kind'] != 'file' or before['flags'] & 0x20
                    or original['xattrs'].get(name) != new
                    or preimage.get('beforeSha256') != new or preimage.get('afterSha256') is not None
                    or 'beforeBase64' not in preimage):
                fail('restored-finalization-unsupported-attribute-change:' + name)
            archived = raw_xattrs(root / 'archive/working' / before['path']).get(name)
            current = raw_xattrs(Path(saved['facts']['release']['path']) / before['path']).get(name)
            if (archived is None or current != archived
                    or hashlib.sha256(archived).hexdigest() != new
                    or base64.b64encode(archived).decode('ascii') != preimage['beforeBase64']):
                fail('restored-finalization-preimage-missing-or-changed')
            total += len(archived) + len(current)
            if total > 16 * 1024 ** 2:
                fail('metadata-recovery-evidence-budget-exceeded')
            changes.append({'part': 'working', 'path': before['path'], 'attribute': name,
                            'beforeSha256': None, 'afterSha256': new,
                            'originalSha256': original['xattrs'][name],
                            'originalBase64': preimage['beforeBase64'],
                            'afterBase64': base64.b64encode(current).decode('ascii')})
    return changes


def restored_finalization_snapshot(request):
    if not re.fullmatch(r'[0-9a-f]{64}', request.get('manifestSha256', '')):
        fail('restored-finalization-manifest-proof-required')
    root, saved = load_transaction(request)
    verify_saved_archive(root, saved)
    prior, located, sources = restored_finalization_context(root, saved, request)
    changes = restored_finalization_changes(root, saved, prior, sources)
    verify_live_common(root, saved, restoring=True)
    if original_sources(root, saved['facts']) != (located, sources):
        fail('restored-finalization-observation-changed')
    evidence = {'version': 1, 'manifestSha256': request['manifestSha256'],
                'transactionIdentity': saved['transactionIdentity'],
                'originalFingerprint': saved['facts']['fingerprint'],
                'acceptedMetadataRecovery': request['metadataRecovery'],
                'postMoveObservations': request['postMoveObservations'],
                'placements': located, 'sources': sources, 'changes': changes}
    return root, evidence


def review_restored_finalization(request):
    root, evidence = restored_finalization_snapshot(request)
    stored = immutable_recovery_evidence(root, 'restored-finalization-', evidence)
    return {'restoredFinalization': {'version': 1, 'evidenceFile': stored['file'],
                                    'evidenceSha256': stored['sha256'], 'digest': stored['digest']},
            'placements': {label: row['state'] for label, row in evidence['placements'].items()},
            'changeCounts': {
                'directoryMtimeChanged': sum(row.get('field') == 'mtimeNs' for row in evidence['changes']),
                'residualCompressionReappeared': sum(row.get('attribute') == 'com.apple.decmpfs'
                                                    for row in evidence['changes'])},
            'changedPaths': len({(row['part'], row['path']) for row in evidence['changes']})}


def verify_restored_finalization(request):
    accepted = request.get('restoredFinalization')
    if (not isinstance(accepted, dict)
            or set(accepted) != {'version', 'evidenceFile', 'evidenceSha256', 'digest'}
            or accepted['version'] != 1):
        fail('restored-finalization-proof-invalid')
    root, evidence = restored_finalization_snapshot(request)
    recorded = load_bound_evidence(root, {'file': accepted['evidenceFile'],
                                         'sha256': accepted['evidenceSha256'],
                                         'digest': accepted['digest']}, 'restored-finalization-')
    if recorded != evidence:
        fail('restored-finalization-review-changed')
    return {'verified': True, 'alreadyRestored': True, 'placements': evidence['placements'],
            'fingerprint': evidence['originalFingerprint'], 'restoredFinalizationAccepted': True}


def verify(request):
    if 'restoredFinalization' in request:
        fail('restored-finalization-separate-command-required')
    if 'quarantineResumption' in request:
        fail('quarantine-resumption-separate-command-required')
    root, saved = load_transaction(request)
    facts = saved['facts']
    recovering = 'metadataRecovery' in request
    if recovering and request.get('mode') != 'restore':
        fail('metadata-recovery-restore-only')
    if request.get('mode') == 'standalone':
        proof = verify_saved_archive(root, saved)
        return {'verified': True, 'standalone': True, 'fingerprint': facts['fingerprint'],
                'restorePath': str(root / 'restore/working'), 'restoreProof': proof}
    located, sources = original_sources(root, facts)
    if recovering:
        verify_metadata_recovery(root, saved, request, located, sources)
    else:
        for label in ('working', 'administration'):
            if sources[label] != facts['sources'][label]:
                fail('source-content-or-identity-changed:' + label)
    verify_saved_archive(root, saved)
    verify_live_common(root, saved, restoring=request.get('mode') == 'restore')
    return {'verified': True, 'placements': located, 'fingerprint': facts['fingerprint'],
            **({'metadataRecoveryAccepted': True} if recovering else {})}


def verify_common_metadata(saved, mutable_shared):
    facts = saved['facts']
    common = safe_path(facts['commonGitDir'])
    check_admin(common, common=True)
    if identity(common) != facts['identity']['common']:
        fail('common-store-incarnation-changed')
    for name, expected in facts['sources']['common'].items():
        if name not in mutable_shared and manifest(common / name, True) != expected:
            fail('common-store-changed:' + name)
    if sorted(p.name for p in common.iterdir() if p.name in COMMON_PARTS and p.name not in mutable_shared) != sorted(
            name for name in facts['sources']['common'] if name not in mutable_shared):
        fail('common-store-layout-changed')
    return common


def verify_live_parent(saved):
    facts = saved['facts']
    head = git(Path(facts['commonGitDir']), Path(facts['repoPath']), 'rev-parse', '--verify',
               'refs/heads/' + facts['release']['branch'] + '^{commit}')
    if head != facts['parent']['head']:
        fail('restore-live-parent-facts-changed')


def verify_live_object_closure(root, common):
    git(root / 'restore/administration', root / 'restore/working',
        'fsck', '--full', '--strict', objects=common / 'objects')
    prove_index_blobs(root / 'restore/administration', root / 'restore/working',
                      objects=common / 'objects')


def verify_live_common(root, saved, restoring):
    common = verify_common_metadata(saved, {'objects', 'refs', 'logs', 'packed-refs'} if restoring else set())
    if restoring:
        # Other branches may legitimately advance after quarantine. Rollback
        # never rewrites shared refs or objects: prove the original private index
        # and HEAD still resolve completely against today's shared store.
        verify_live_parent(saved)
        verify_live_object_closure(root, common)


def require_no_packed_ref(common, ref, oid_length):
    path = common / 'packed-refs'
    if not os.path.lexists(path):
        return
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        fail('deleted-branch-packed-refs-unreadable')
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            fail('deleted-branch-packed-refs-unsafe')
        budget = 16 * 1024 ** 2
        if before.st_size > budget:
            fail('deleted-branch-packed-refs-budget-exceeded')
        seen, peeled_allowed, total, count = set(), False, 0, 0
        oid_pattern = rb'[0-9a-fA-F]{' + str(oid_length).encode('ascii') + rb'}'
        target = os.fsencode(ref)
        while True:
            line = source.readline(65537)
            if not line:
                break
            total += len(line)
            count += 1
            if len(line) > 65536 or total > budget or count > MAX_FILES:
                fail('deleted-branch-packed-refs-budget-exceeded')
            line = line[:-1] if line.endswith(b'\n') else line
            if line.startswith(b'#'):
                continue
            if line.startswith(b'^'):
                if not peeled_allowed or not re.fullmatch(oid_pattern, line[1:]):
                    fail('deleted-branch-packed-refs-malformed')
                peeled_allowed = False
                continue
            oid, separator, name = line.partition(b' ')
            components = name.split(b'/')
            if (not separator or not re.fullmatch(oid_pattern, oid) or not any(value != 48 for value in oid)
                    or not name.startswith(b'refs/') or name.endswith((b'/', b'.'))
                    or b'..' in name or b'@{' in name
                    or any(value < 33 or value == 127 or value in b'~^:?*[\\' for value in name)
                    or any(not part or part.startswith(b'.') or part.endswith(b'.lock') for part in components)
                    or name in seen):
                fail('deleted-branch-packed-refs-malformed')
            seen.add(name)
            peeled_allowed = True
            if name == target:
                fail('quarantine-resumption-retired-branch-not-absent')
        lease = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size,
                               value.st_uid, value.st_gid, value.st_mtime_ns, value.st_ctime_ns)
        try:
            unchanged = lease(before) == lease(os.fstat(source.fileno())) == lease(path.lstat())
        except OSError:
            unchanged = False
        if not unchanged:
            fail('deleted-branch-packed-refs-changed')


def verify_deleted_parent(saved, request):
    facts = saved['facts']
    receipt = request.get('confirmedDeletion')
    # The service derives this binding only from its validated durable receipt,
    # never from ref absence or a deletion intent. This command writes no refs.
    if (not isinstance(receipt, dict) or set(receipt) != {'journalDigest', 'branch', 'head', 'phase'}
            or not isinstance(receipt['journalDigest'], str)
            or not re.fullmatch(r'[0-9a-f]{64}', receipt['journalDigest'])
            or receipt['branch'] != facts['release']['branch']
            or receipt['head'] != facts['parent']['head']
            or receipt['phase'] not in ('branch-retired', 'retired')):
        fail('quarantine-resumption-confirmed-deletion-required')
    ref = 'refs/heads/' + facts['release']['branch']
    def require_no_loose_ref():
        current = safe_path(facts['commonGitDir'])
        if identity(current) != facts['identity']['common']:
            fail('common-store-incarnation-changed')
        parts = ref.split('/')
        if any(part in ('', '.', '..') for part in parts):
            fail('quarantine-resumption-retired-branch-not-absent')
        for index, part in enumerate(parts):
            current = current / part
            try:
                info = current.lstat()
            except FileNotFoundError:
                break
            # Git can report a malformed loose ref as missing. Preserve and
            # refuse every occupied leaf and every unsafe parent component.
            if index == len(parts) - 1 or not stat.S_ISDIR(info.st_mode):
                fail('quarantine-resumption-retired-branch-not-absent')
    require_no_loose_ref()
    require_no_packed_ref(safe_path(facts['commonGitDir']), ref, len(facts['parent']['head']))
    try:
        # Also check packed refs. Any status other than Git's exact missing
        # status holds; filesystem checks separately cover skipped loose refs.
        git(Path(facts['commonGitDir']), Path(facts['repoPath']),
            'show-ref', '--verify', '--quiet', ref, expected_returncode=1)
    except RuntimeError:
        fail('quarantine-resumption-retired-branch-not-absent')
    require_no_packed_ref(safe_path(facts['commonGitDir']), ref, len(facts['parent']['head']))
    require_no_loose_ref()


def verify_deleted_branch(request):
    if not re.fullmatch(r'[0-9a-f]{64}', request.get('manifestSha256', '')):
        fail('deleted-branch-manifest-proof-required')
    _, saved = load_transaction(request)
    verify_deleted_parent(saved, request)
    return {'verified': True, 'branchAbsent': True, 'confirmedDeletion': request['confirmedDeletion']}


def quarantine_observation(request, retired=False):
    if 'metadataRecovery' in request or 'restoredFinalization' in request:
        fail('quarantine-resumption-purpose-mismatch')
    if not re.fullmatch(r'[0-9a-f]{64}', request.get('manifestSha256', '')):
        fail('quarantine-resumption-manifest-proof-required')
    root, saved = load_transaction(request)
    located, sources = original_sources(root, saved['facts'])
    if located['working']['state'] != 'quarantine':
        fail('quarantine-resumption-working-placement-required')
    if retired and located['administration']['state'] != 'quarantine':
        fail('quarantine-resumption-completed-placement-required')
    verify_saved_archive(root, saved)
    changes = metadata_recovery_changes(root, saved, located, sources)
    if retired:
        verify_deleted_parent(saved, request)
        # Receipt replay restores nothing. The strict standalone archive proof
        # above retains closure even after legitimate live-store garbage collection.
        verify_common_metadata(saved, {'objects', 'refs', 'logs', 'packed-refs'})
    else:
        verify_live_common(root, saved, restoring=True)
    if original_sources(root, saved['facts']) != (located, sources):
        fail('quarantine-resumption-observation-changed')
    # The full source/archive scans may be long. Pin the ref condition again
    # before returning the observation to the service's fresh ownership gate.
    if retired:
        verify_deleted_parent(saved, request)
    else:
        verify_live_parent(saved)
    return root, saved, located, sources, changes


def review_quarantine_resumption(request):
    root, saved, located, sources, changes = quarantine_observation(request)
    evidence = {'version': 1, 'purpose': 'resume-initialized-quarantine',
                'manifestSha256': request['manifestSha256'],
                'transactionIdentity': saved['transactionIdentity'],
                'originalFingerprint': saved['facts']['fingerprint'],
                'initialPlacements': {label: row['state'] for label, row in located.items()},
                'sources': sources, 'changes': changes}
    stored = immutable_recovery_evidence(root, 'quarantine-resumption-', evidence)
    return {'quarantineResumption': {'version': 1, 'evidenceFile': stored['file'],
                                    'evidenceSha256': stored['sha256'], 'digest': stored['digest']},
            'initialPlacements': evidence['initialPlacements'],
            'changeCounts': {
                'residualCompressionRemoved': sum(row['attribute'] == 'com.apple.decmpfs' for row in changes),
                'rootProvenanceAdded': sum(row['attribute'] == 'com.apple.provenance' for row in changes)},
            'changedPaths': len({(row['part'], row['path']) for row in changes})}


def verified_quarantine_resumption(request, completed=False, retired=False):
    accepted = request.get('quarantineResumption')
    if (not isinstance(accepted, dict)
            or set(accepted) != {'version', 'evidenceFile', 'evidenceSha256', 'digest'}
            or accepted['version'] != 1):
        fail('quarantine-resumption-proof-invalid')
    root, saved, located, sources, changes = quarantine_observation(request, retired=retired)
    evidence = load_bound_evidence(root, {'file': accepted['evidenceFile'],
                                         'sha256': accepted['evidenceSha256'],
                                         'digest': accepted['digest']},
                                   'quarantine-resumption-', reason='quarantine-resumption')
    if (not isinstance(evidence, dict)
            or set(evidence) != {'version', 'purpose', 'manifestSha256', 'transactionIdentity',
                                 'originalFingerprint', 'initialPlacements', 'sources', 'changes'}
            or evidence['version'] != 1 or evidence['purpose'] != 'resume-initialized-quarantine'
            or evidence['manifestSha256'] != request['manifestSha256']
            or evidence['transactionIdentity'] != saved['transactionIdentity']
            or evidence['originalFingerprint'] != saved['facts']['fingerprint']
            or not isinstance(evidence['initialPlacements'], dict)
            or set(evidence['initialPlacements']) != {'working', 'administration'}
            or evidence['initialPlacements']['working'] != 'quarantine'
            or evidence['initialPlacements']['administration'] not in ('original', 'quarantine')):
        fail('quarantine-resumption-proof-invalid')
    if sources != evidence['sources'] or changes != evidence['changes']:
        fail('quarantine-resumption-review-changed')
    if (evidence['initialPlacements']['administration'] == 'quarantine'
            and located['administration']['state'] != 'quarantine'):
        fail('quarantine-resumption-placement-regressed')
    if completed and located['administration']['state'] != 'quarantine':
        fail('quarantine-resumption-completed-placement-required')
    return {'verified': True, 'placements': located, 'fingerprint': saved['facts']['fingerprint'],
            'quarantineResumptionAccepted': True,
            **({'confirmedDeletion': request['confirmedDeletion']} if retired else {})}


def verify_quarantine_resumption(request):
    return verified_quarantine_resumption(request)


def verify_completed_quarantine(request):
    return verified_quarantine_resumption(request, completed=True)


def verify_retired_quarantine(request):
    return verified_quarantine_resumption(request, completed=True, retired=True)


def await_mutation_permit(request):
    """Automatic callers recheck the live daemon gate after native verification.

    The backend lock stays held while waiting. EOF, missing/invalid replies and
    parent death grant nothing; explicit operations retain their old protocol.
    """
    token = request.get('mutationPermit')
    if token is None:
        return
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9-]{36}', token):
        fail('mutation-permit-invalid')
    print(json.dumps({'mutationReady': token, 'part': 'administration'}), flush=True)
    reply = sys.stdin.readline(4097)
    try:
        accepted = json.loads(reply)
    except (ValueError, TypeError):
        fail('mutation-permit-missing')
    if (len(reply) > 4096 or not reply.endswith('\n') or not isinstance(accepted, dict)
            or set(accepted) != {'mutationPermit', 'allow'}
            or accepted['mutationPermit'] != token or accepted['allow'] is not True):
        fail('mutation-permit-invalid')


def resume_quarantine(request):
    verified = verify_quarantine_resumption(request)
    if verified['placements']['administration']['state'] == 'quarantine':
        return {'moved': False, 'alreadyQuarantined': True, 'part': 'administration',
                'direction': 'quarantine', 'placements': verified['placements']}
    root, saved = load_transaction(request)
    facts = saved['facts']
    source, destination = Path(facts['privateGitDir']), root / 'quarantine/administration'
    safe_path(str(source))
    safe_path(str(destination.parent))
    if identity(source) != facts['identity']['administration'] or os.path.lexists(destination):
        fail('move-lease-or-destination-changed')
    await_mutation_permit(request)
    if identity(source) != facts['identity']['administration'] or os.path.lexists(destination):
        fail('move-lease-or-destination-changed')
    exclusive_rename(source, destination)
    fsync_dir(source.parent)
    fsync_dir(destination.parent)
    if identity(destination) != facts['identity']['administration']:
        fail('post-move-identity-uncertain')
    located, sources = original_sources(root, facts)
    observation = immutable_recovery_evidence(root, 'quarantine-resumption-postmove-', {
        'version': 1, 'purpose': 'resume-initialized-quarantine',
        'manifestSha256': request['manifestSha256'],
        'acceptedQuarantineResumption': request['quarantineResumption'],
        'part': 'administration', 'placements': located, 'sources': sources})
    try:
        verify_completed_quarantine(request)
    except Exception as error:
        fail('quarantine-resumption-postmove-changed:' + observation['file'] + ':' + str(error))
    return {'moved': True, 'part': 'administration', 'direction': 'quarantine',
            'placements': located, 'postMoveObservation': observation}


def exclusive_rename(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    libc.renamex_np.restype = ctypes.c_int
    # RENAME_EXCL = 0x00000004, sys/stdio.h; never replace any occupied path.
    if libc.renamex_np(os.fsencode(source), os.fsencode(destination), 0x00000004):
        raise OSError(ctypes.get_errno(), 'exclusive-rename-failed')


def move(request):
    part, direction = request['part'], request['direction']
    if part not in ('working', 'administration') or direction not in ('quarantine', 'restore'):
        fail('invalid-move')
    if 'metadataRecovery' in request and direction != 'restore':
        fail('metadata-recovery-restore-only')
    verified = verify({**request, 'mode': 'restore' if direction == 'restore' else 'fresh'})
    root, saved = load_transaction(request)
    facts = saved['facts']
    original = Path(facts['release']['path'] if part == 'working' else facts['privateGitDir'])
    quarantined = root / 'quarantine' / part
    source, destination = (original, quarantined) if direction == 'quarantine' else (quarantined, original)
    expected_state = 'original' if direction == 'quarantine' else 'quarantine'
    if direction == 'restore' and verified['placements'][part]['state'] == 'original':
        return {'moved': False, 'alreadyRestored': True, 'part': part,
                'direction': direction, 'placements': verified['placements']}
    if verified['placements'][part]['state'] != expected_state:
        fail('move-already-executed-or-uncertain')
    safe_path(str(source))
    safe_path(str(destination.parent))
    if identity(source) != facts['identity'][part] or os.path.lexists(destination):
        fail('move-lease-or-destination-changed')
    exclusive_rename(source, destination)
    fsync_dir(source.parent)
    fsync_dir(destination.parent)
    if identity(destination) != facts['identity'][part]:
        fail('post-move-identity-uncertain')
    result = {'moved': True, 'part': part, 'direction': direction, 'placements': placements(root, facts)}
    if 'metadataRecovery' in request:
        located, sources = original_sources(root, facts)
        observation = immutable_recovery_evidence(root, 'metadata-recovery-postmove-', {
            'version': 1, 'manifestSha256': request['manifestSha256'],
            'acceptedMetadataRecovery': request['metadataRecovery'],
            'part': part, 'placements': located, 'sources': sources})
        try:
            verify({**request, 'mode': 'restore'})
        except Exception as error:
            fail('metadata-recovery-postmove-changed:' + observation['file'] + ':' + str(error))
        result['postMoveObservation'] = observation
    return result


def main():
    request = json.loads(sys.stdin.readline())
    if sys.platform != 'darwin':
        fail('darwin-required')
    action = request['command']
    if action == 'lock':
        fd = lock_file(transaction(request['transactionDir']), 'execution.lock')
        try:
            print(json.dumps({'ok': True}), flush=True)
            # No commands are interpreted while the parent holds this lease.
            while sys.stdin.buffer.read(65536):
                pass
        finally:
            os.close(fd)
        return
    if action == 'inspect':
        result = inspect(request)
    elif action == 'status':
        root, saved = load_transaction(request)
        result = {'placements': placements(root, saved['facts']), 'fingerprint': saved['facts']['fingerprint']}
    elif action in ('preserve', 'verify', 'move', 'review-metadata-recovery',
                    'review-restored-finalization', 'verify-restored-finalization',
                    'review-quarantine-resumption', 'verify-quarantine-resumption', 'resume-quarantine',
                    'verify-completed-quarantine', 'verify-retired-quarantine', 'verify-deleted-branch',
                    'verify-unmoved-preservation'):
        fd = lock_file(transaction(request['transactionDir']), 'backend.lock')
        try:
            result = {'preserve': preserve, 'verify': verify, 'move': move,
                      'review-metadata-recovery': review_metadata_recovery,
                      'review-restored-finalization': review_restored_finalization,
                      'verify-restored-finalization': verify_restored_finalization,
                      'review-quarantine-resumption': review_quarantine_resumption,
                      'verify-quarantine-resumption': verify_quarantine_resumption,
                      'resume-quarantine': resume_quarantine,
                      'verify-completed-quarantine': verify_completed_quarantine,
                      'verify-retired-quarantine': verify_retired_quarantine,
                      'verify-deleted-branch': verify_deleted_branch,
                      'verify-unmoved-preservation': verify_unmoved_preservation}[action](request)
        finally:
            os.close(fd)
    else:
        fail('unknown-command')
    print(json.dumps({'ok': True, **result}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'reason': str(error)}), flush=True)
        sys.exit(1)
