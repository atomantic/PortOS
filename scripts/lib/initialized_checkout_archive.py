#!/usr/bin/env python3
"""Private Darwin archive backend. JSON-line stdin/stdout; service owns authority.

Never deletes original checkouts or Git administration. A move is one reversible
RENAME_EXCL; the caller must journal and fence each half of the transaction.
"""
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

MAX_FILES = 200000
MAX_BYTES = 20 * 1024 ** 3
COMMON_PARTS = ('HEAD', 'objects', 'refs', 'logs', 'packed-refs', 'config', 'info',
                'description', 'hooks', 'rr-cache')
OPERATIONS = ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
              'rebase-merge', 'rebase-apply', 'sequencer', 'shallow')


def fail(reason):
    raise RuntimeError(reason)


def command(args, env=None, input_data=None):
    result = subprocess.run(args, capture_output=True, text=True, env=env,
                            timeout=1200, **({'stdin': subprocess.DEVNULL} if input_data is None else {'input': input_data}))
    if result.returncode:
        fail('command-failed:' + str(args[0]) + ':' + result.stderr[-1200:])
    return result.stdout


def git(admin, work, *args, objects=None, input_data=None):
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
                    '-c', 'core.hooksPath=' + os.devnull, *args], env, input_data).strip()


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


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_json(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as out:
        json.dump(data, out, sort_keys=True)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    fsync_dir(path.parent)


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


def check_admin(admin, module=False):
    if any((admin / name).exists() for name in OPERATIONS):
        fail('active-or-partial-git-state')
    for name in ('objects/info/alternates', 'objects/info/http-alternates', 'info/grafts'):
        if (admin / name).exists():
            fail('external-object-dependency')
    if module and any((admin / name).exists() for name in ('commondir', 'worktrees', 'modules')):
        fail('shared-or-nested-module')
    # Only walk the current private administration; the common worktrees/ tree
    # belongs to other live agents and is deliberately outside this capture.
    for current, dirs, files in os.walk(admin, followlinks=False):
        if Path(current) == admin and not module:
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
    check_admin(common)
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
    with path.open('w') as out:
        out.write(text)
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
    for label, source in [('working', work), ('administration', admin)]:
        copy_tree(source, root / 'archive' / label)
        if not same_copy(manifest(root / 'archive' / label), before['sources'][label]):
            fail('archive-metadata-mismatch:' + label)
    (root / 'archive' / 'common').mkdir(mode=0o700)
    for name, expected_rows in before['sources']['common'].items():
        copy_tree(common / name, root / 'archive' / 'common' / name)
        if not same_copy(manifest(root / 'archive' / 'common' / name, True), expected_rows):
            fail('shared-archive-metadata-mismatch:' + name)
    for label in ('working', 'administration', 'common'):
        copy_tree(root / 'archive' / label, root / 'restore' / label)
        if not same_copy(manifest(root / 'archive' / label), manifest(root / 'restore' / label)):
            fail('restore-copy-metadata-mismatch')
    restore = root / 'restore'
    rewrite_copy(restore / 'working' / '.git', 'gitdir: ' + str(restore / 'administration') + '\n')
    rewrite_copy(restore / 'administration' / 'commondir', str(restore / 'common') + '\n')
    rewrite_copy(restore / 'administration' / 'gitdir', str(restore / 'working' / '.git') + '\n')
    for m in before['modules']:
        store, tree = restore / 'administration' / m['administrationPath'], restore / 'working' / m['path']
        rewrite_copy(tree / '.git', 'gitdir: ' + str(store) + '\n')
        git(store, tree, 'config', '--file', str(store / 'config'), 'core.worktree', str(tree))
    proof = proof_repositories(root, before)
    # Check source metadata again after both full copies and offline proof.
    after = inspect(request, full=True)
    if before != after:
        fail('sources-changed-during-preservation')
    restored = {label: manifest(restore / label) for label in ('working', 'administration', 'common')}
    durable_tree(root / 'archive')
    durable_tree(restore)
    saved = {'version': 1, 'transactionIdentity': identity(root), 'facts': before,
             'restored': restored, 'restoreProof': proof}
    private_json(root / 'manifest.json', saved)
    return {'manifestPath': str(root / 'manifest.json'), 'fingerprint': before['fingerprint'],
            'administrationFingerprint': before['administrationFingerprint'], 'restoreProof': proof}


def load_transaction(request):
    root = transaction(request['transactionDir'])
    path = root / 'manifest.json'
    if not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_size > 256 * 1024 ** 2:
        fail('invalid-archive-manifest')
    saved = json.loads(path.read_text())
    if saved['version'] != 1 or saved['transactionIdentity'] != identity(root):
        fail('transaction-incarnation-changed')
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


def verify_saved_archive(root, saved):
    facts = saved['facts']
    for label in ('working', 'administration'):
        if not same_copy(manifest(root / 'archive' / label), facts['sources'][label]):
            fail('archive-changed:' + label)
    for name, expected in facts['sources']['common'].items():
        if not same_copy(manifest(root / 'archive' / 'common' / name, True), expected):
            fail('common-archive-changed:' + name)
    if sorted(p.name for p in (root / 'archive/common').iterdir()) != sorted(facts['sources']['common']):
        fail('common-archive-layout-changed')
    for label, expected in saved['restored'].items():
        if manifest(root / 'restore' / label) != expected:
            fail('restore-proof-changed:' + label)
    return proof_repositories(root, facts)


def verify(request):
    root, saved = load_transaction(request)
    facts = saved['facts']
    if request.get('mode') == 'standalone':
        proof = verify_saved_archive(root, saved)
        return {'verified': True, 'standalone': True, 'fingerprint': facts['fingerprint'],
                'restorePath': str(root / 'restore/working'), 'restoreProof': proof}
    located = placements(root, facts)
    for label in ('working', 'administration'):
        state = located[label]['state']
        if state == 'ambiguous':
            fail('ambiguous-source-placement:' + label)
        path = Path(facts['release']['path'] if label == 'working' else facts['privateGitDir']) if state == 'original' else root / 'quarantine' / label
        if manifest(path) != facts['sources'][label]:
            fail('source-content-or-identity-changed:' + label)
    common = safe_path(facts['commonGitDir'])
    check_admin(common)
    if identity(common) != facts['identity']['common']:
        fail('common-store-incarnation-changed')
    restoring = request.get('mode') == 'restore'
    mutable_shared = {'objects', 'refs', 'logs', 'packed-refs'} if restoring else set()
    for name, expected in facts['sources']['common'].items():
        if name not in mutable_shared and manifest(common / name, True) != expected:
            fail('common-store-changed:' + name)
    if sorted(p.name for p in common.iterdir() if p.name in COMMON_PARTS and p.name not in mutable_shared) != sorted(
            name for name in facts['sources']['common'] if name not in mutable_shared):
        fail('common-store-layout-changed')
    verify_saved_archive(root, saved)
    if restoring:
        # Other branches may legitimately advance after quarantine. Rollback
        # never rewrites shared refs or objects: prove the original private index
        # and HEAD still resolve completely against today's shared store.
        head = git(common, Path(facts['repoPath']), 'rev-parse', '--verify',
                   'refs/heads/' + facts['release']['branch'] + '^{commit}')
        if head != facts['parent']['head']:
            fail('restore-live-parent-facts-changed')
        git(root / 'restore/administration', root / 'restore/working',
            'fsck', '--full', '--strict', objects=common / 'objects')
        prove_index_blobs(root / 'restore/administration', root / 'restore/working',
                          objects=common / 'objects')
    return {'verified': True, 'placements': located, 'fingerprint': facts['fingerprint']}


def move(request):
    part, direction = request['part'], request['direction']
    if part not in ('working', 'administration') or direction not in ('quarantine', 'restore'):
        fail('invalid-move')
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
    libc = ctypes.CDLL(None, use_errno=True)
    libc.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    libc.renamex_np.restype = ctypes.c_int
    # RENAME_EXCL = 0x00000004, sys/stdio.h; never replace any occupied path.
    if libc.renamex_np(os.fsencode(source), os.fsencode(destination), 0x00000004):
        raise OSError(ctypes.get_errno(), 'exclusive-rename-failed')
    fsync_dir(source.parent)
    fsync_dir(destination.parent)
    if identity(destination) != facts['identity'][part]:
        fail('post-move-identity-uncertain')
    return {'moved': True, 'part': part, 'direction': direction, 'placements': placements(root, facts)}


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
    elif action in ('preserve', 'verify', 'move'):
        fd = lock_file(transaction(request['transactionDir']), 'backend.lock')
        try:
            result = {'preserve': preserve, 'verify': verify, 'move': move}[action](request)
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
