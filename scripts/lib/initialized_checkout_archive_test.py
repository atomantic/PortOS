"""Disposable native integration fixtures; never use an installed checkout."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('initialized_checkout_archive.py'))
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)


@unittest.skipUnless(sys.platform == 'darwin', 'Darwin metadata/rename ABI required')
class NativeArchive(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix='initialized-archive-test-')).resolve()
        self.repo, self.work, self.module = [self.scratch / n for n in ('repo', 'work', 'module')]
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                        GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid')
        for path in (self.repo, self.module):
            path.mkdir()
            self.git(path, 'init', '-b', 'main')
            (path / 'base.txt').write_text('base\n')
            self.git(path, 'add', '.')
            self.git(path, 'commit', '-m', 'fixture base')
        self.git(self.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', self.module.as_uri(), 'sub')
        self.git(self.repo, 'commit', '-am', 'fixture module')
        self.git(self.repo, 'worktree', 'add', '-b', 'feature/fixture', str(self.work))
        self.git(self.work, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init')
        self.git(self.repo, 'worktree', 'lock', '--reason', 'fixture held', str(self.work))
        for tree in (self.work, self.work / 'sub'):
            (tree / 'staged.txt').write_text('only in index\n')
            self.git(tree, 'add', 'staged.txt')
            (tree / 'staged.txt').unlink()
            recovery = self.git(tree, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD',
                                '-m', 'reachable only through recovery ref')
            recovery_ref = 'refs/worktree/recovery' if tree == self.work else 'refs/private/recovery'
            self.git(tree, 'update-ref', recovery_ref, recovery)
        (self.work / 'ignored').write_text('ignored evidence\n')
        (self.work / '.gitignore').write_text('ignored\n')
        (self.work / 'empty').mkdir()
        os.link(self.work / 'ignored', self.work / 'hardlink')
        os.symlink('/unavailable/fixture/dependencies', self.work / 'node_modules')
        self.git(self.work, 'config', 'core.fsmonitor', '!must-not-run')
        self.txn = self.scratch / 'transaction'
        self.txn.mkdir(mode=0o700)
        self.request = {'repoPath': str(self.repo), 'release': {'path': str(self.work),
                         'head': self.git(self.work, 'rev-parse', 'HEAD'), 'branch': 'feature/fixture',
                         'locked': True, 'lockReason': 'fixture held'}, 'transactionDir': str(self.txn)}

    def git(self, cwd, *args):
        return subprocess.check_output(['git', '-C', str(cwd), '-c', 'core.hooksPath=' + os.devnull,
                                        *args], env=self.env, stderr=subprocess.PIPE, text=True).strip()

    def tearDown(self):
        for current, _, files in os.walk(self.scratch, followlinks=False):
            for name in files:
                path = Path(current) / name
                if not path.is_symlink() and archive.acl(path):
                    subprocess.run(['/bin/chmod', '-N', str(path)], check=True)
        shutil.rmtree(self.scratch)

    def preserve(self):
        self.request['expected'] = archive.inspect(self.request)
        return archive.preserve(self.request)

    def test_admission_bookkeeping_does_not_change_source_review(self):
        before = archive.inspect(self.request)
        admission = Path(before['commonGitDir']) / 'portos-checkout-admission'
        admission.mkdir(mode=0o700)
        (admission / 'writer.lock').write_text('owned service bookkeeping')
        self.assertEqual(archive.inspect(self.request), before)

    def test_common_runtime_sockets_are_outside_capture_but_private_and_captured_sockets_hold(self):
        facts = archive.inspect(self.request)
        common = Path(facts['commonGitDir'])
        private = Path(facts['privateGitDir'])
        # Relative bind avoids Darwin's short AF_UNIX path limit. No daemon is
        # started; sockets and stores belong exclusively to this fixture.
        def bind(path):
            listener = socket.socket(socket.AF_UNIX)
            previous = Path.cwd()
            try:
                os.chdir(path.parent)
                listener.bind(path.name)
            finally:
                os.chdir(previous)
            self.addCleanup(listener.close)
            return listener

        excluded = (common / 'fsmonitor--daemon.ipc',
                    common / 'modules/sub/fsmonitor--daemon.ipc')
        for path in excluded:
            bind(path)
        socket_leases = [(path.lstat().st_ino, path.lstat().st_mode) for path in excluded]
        self.assertEqual(archive.inspect(self.request), facts)
        self.preserve()
        self.assertTrue(archive.verify(self.request)['verified'])
        self.assertFalse((self.txn / 'archive/common/fsmonitor--daemon.ipc').exists())
        self.assertFalse((self.txn / 'archive/common/modules').exists())
        self.assertTrue(archive.verify({**self.request, 'mode': 'standalone'})['standalone'])
        self.assertEqual([(path.lstat().st_ino, path.lstat().st_mode) for path in excluded], socket_leases)

        for path in (common / 'objects/fixture.ipc', common / 'refs/fixture.ipc',
                     common / 'rr-cache', private / 'fixture.ipc',
                     Path(facts['modules'][0]['gitDir']) / 'fixture.ipc'):
            parent_stat = path.parent.stat()
            listener = bind(path)
            try:
                with self.assertRaisesRegex(RuntimeError, 'special-git-file-unsupported'):
                    archive.inspect(self.request)
                with self.assertRaisesRegex(RuntimeError, 'special-(git-)?file-unsupported'):
                    archive.verify(self.request)
            finally:
                listener.close()
                path.unlink()
                os.utime(path.parent, ns=(parent_stat.st_atime_ns, parent_stat.st_mtime_ns))
        # Shared operation and dependency guards must not disappear with the
        # narrower payload walk, including locks outside COMMON_PARTS.
        for relative, reason in (('index.lock', 'active-or-dependent-git-state'),
                                 ('MERGE_HEAD', 'active-or-partial-git-state'),
                                 ('objects/info/alternates', 'external-object-dependency')):
            path = common / relative
            path.write_text('held')
            try:
                with self.assertRaisesRegex(RuntimeError, reason):
                    archive.inspect(self.request)
                with self.assertRaisesRegex(RuntimeError, reason):
                    archive.verify(self.request)
            finally:
                path.unlink()

    def test_restore_is_offline_and_preserves_staged_private_and_metadata(self):
        subprocess.run(['/usr/bin/xattr', '-w', 'fixture.attribute', 'preserved', str(self.work / 'ignored')], check=True)
        subprocess.run(['/usr/bin/xattr', '-w', 'com.apple.decmpfs', 'fixture-residual',
                        str(self.work / 'ignored')], check=True)
        subprocess.run(['/bin/chmod', '+a', 'everyone deny delete', str(self.work / 'ignored')], check=True)
        os.chflags(self.work / 'ignored', 0x40)  # UF_TRACKED, omitted by ditto.
        proof = self.preserve()
        self.assertEqual(len(proof['restoreProof']), 2)
        self.assertTrue(archive.verify(self.request)['verified'])
        saved = json.loads((self.txn / 'manifest.json').read_text())
        # All original Git stores and working trees become unavailable. The proof
        # must still resolve parent and module index-only blobs from copied stores.
        self.repo.rename(self.scratch / 'repo-offline')
        self.work.rename(self.scratch / 'work-offline')
        self.module.rename(self.scratch / 'module-offline')
        archive.proof_repositories(self.txn, saved['facts'])
        for entry in saved['restoreProof']:
            self.assertEqual(entry['fsck'], 'passed')
        self.assertEqual(os.readlink(self.txn / 'archive/working/node_modules'), '/unavailable/fixture/dependencies')
        self.assertEqual((self.txn / 'archive/working/ignored').stat().st_ino,
                         (self.txn / 'archive/working/hardlink').stat().st_ino)
        self.assertEqual(archive.raw_xattrs(self.txn / 'archive/working/ignored')['com.apple.decmpfs'],
                         b'fixture-residual')

    def test_individual_moves_survive_restart_and_rollback_without_unlocking(self):
        self.preserve()
        before = archive.identity(self.work)
        result = archive.move({**self.request, 'part': 'working', 'direction': 'quarantine'})
        self.assertEqual(result['placements']['working']['state'], 'quarantine')
        # Freshly loaded state sees a partial move; no module operation runs.
        self.assertTrue(archive.verify(self.request)['verified'])
        archive.move({**self.request, 'part': 'administration', 'direction': 'quarantine'})
        self.assertEqual((self.txn / 'quarantine/administration/locked').read_text().strip(), 'fixture held')
        self.assertTrue(archive.verify(self.request)['verified'])
        archive.move({**self.request, 'part': 'administration', 'direction': 'restore'})
        archive.move({**self.request, 'part': 'working', 'direction': 'restore'})
        self.assertTrue(archive.move({**self.request, 'part': 'working',
                                      'direction': 'restore'})['alreadyRestored'])
        self.assertEqual(archive.identity(self.work), before)
        self.assertEqual(self.git(self.work, 'rev-parse', 'HEAD'), self.request['release']['head'])

    def test_fresh_process_refuses_foreign_rollback_target(self):
        self.preserve()
        archive.move({**self.request, 'part': 'working', 'direction': 'quarantine'})
        self.work.mkdir()
        (self.work / 'new-owner').write_text('keep this incarnation')
        result = subprocess.run([sys.executable, str(Path(archive.__file__))],
                                input=json.dumps({**self.request, 'command': 'move',
                                                  'part': 'working', 'direction': 'restore'}) + '\n',
                                text=True, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, 1)
        self.assertIn('ambiguous-source-placement', json.loads(result.stdout)['reason'])
        self.assertEqual((self.work / 'new-owner').read_text(), 'keep this incarnation')
        self.assertEqual((self.txn / 'quarantine/working/ignored').read_text(), 'ignored evidence\n')

    def test_rollback_allows_unrelated_refs_but_never_changes_shared_store(self):
        self.preserve()
        for part in ('working', 'administration'):
            archive.move({**self.request, 'part': part, 'direction': 'quarantine'})
        self.git(self.repo, 'update-ref', 'refs/heads/another-agent', 'HEAD')
        with self.assertRaisesRegex(RuntimeError, 'common-store-changed'):
            archive.verify(self.request)
        # The service's durable reservation is outside the captured common parts.
        before = archive.manifest(self.repo / '.git', True)
        self.assertTrue(archive.verify({**self.request, 'mode': 'restore'})['verified'])
        self.assertEqual(archive.manifest(self.repo / '.git', True), before)
        for part in ('administration', 'working'):
            archive.move({**self.request, 'part': part, 'direction': 'restore'})
        self.assertEqual(self.git(self.repo, 'rev-parse', 'another-agent'), self.git(self.repo, 'rev-parse', 'HEAD'))

    def test_rollback_holds_missing_shared_objects_or_deleted_branch(self):
        staged = self.git(self.work, 'rev-parse', ':staged.txt')
        self.preserve()
        for part in ('working', 'administration'):
            archive.move({**self.request, 'part': part, 'direction': 'quarantine'})
        self.git(self.repo, 'update-ref', '-d', 'refs/heads/feature/fixture')
        with self.assertRaisesRegex(RuntimeError, 'command-failed'):
            archive.move({**self.request, 'part': 'administration', 'direction': 'restore'})
        self.git(self.repo, 'update-ref', 'refs/heads/feature/fixture', self.request['release']['head'])
        # Simulate loss only in this disposable live store; archive remains exact.
        (self.repo / '.git/objects' / staged[:2] / staged[2:]).unlink()
        with self.assertRaisesRegex(RuntimeError, 'missing-or-invalid-index-object'):
            archive.move({**self.request, 'part': 'administration', 'direction': 'restore'})
        self.assertFalse(self.work.exists())
        self.assertTrue((self.txn / 'quarantine/administration/locked').exists())
        self.assertTrue((self.txn / 'archive/common/objects' / staged[:2] / staged[2:]).exists())
        self.git(self.repo, 'update-ref', '-d', 'refs/heads/feature/fixture')
        self.repo.rename(self.scratch / 'repo-offline')
        self.module.rename(self.scratch / 'module-offline')
        standalone = archive.verify({**self.request, 'mode': 'standalone'})
        self.assertTrue(standalone['standalone'])
        restored = Path(standalone['restorePath'])
        self.assertEqual(self.git(restored, 'rev-parse', 'HEAD'), self.request['release']['head'])
        for tree, recovery_ref in ((restored, 'refs/worktree/recovery'),
                                    (restored / 'sub', 'refs/private/recovery')):
            self.assertEqual(self.git(tree, '-c', 'core.fsmonitor=false', 'show', ':staged.txt'),
                             'only in index')
            self.assertNotEqual(self.git(tree, 'rev-parse', recovery_ref), self.git(tree, 'rev-parse', 'HEAD'))

    def test_execution_lock_lasts_until_parent_stdin_closes(self):
        holder = subprocess.Popen([sys.executable, str(Path(archive.__file__))],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=self.env)
        try:
            holder.stdin.write(json.dumps({'command': 'lock', 'transactionDir': str(self.txn)}) + '\n')
            holder.stdin.flush()
            self.assertEqual(json.loads(holder.stdout.readline()), {'ok': True})
            with self.assertRaisesRegex(RuntimeError, 'backend-busy'):
                archive.lock_file(self.txn, 'execution.lock')
            holder.stdin.close()
            self.assertEqual(holder.wait(timeout=5), 0)
            fd = archive.lock_file(self.txn, 'execution.lock')
            os.close(fd)
        finally:
            if holder.poll() is None:
                holder.terminate()
                holder.wait(timeout=5)
            holder.stdout.close()
            holder.stderr.close()

    def test_holds_changed_source_and_occupied_destination(self):
        self.preserve()
        (self.work / 'later.txt').write_text('later owner')
        with self.assertRaisesRegex(RuntimeError, 'source-content-or-identity-changed'):
            archive.move({**self.request, 'part': 'working', 'direction': 'quarantine'})
        self.assertTrue(self.work.exists())
        self.assertFalse((self.txn / 'quarantine/working').exists())
        # An occupied destination is retained regardless of its contents.
        (self.txn / 'quarantine/working').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'ambiguous-source-placement'):
            archive.move({**self.request, 'part': 'working', 'direction': 'quarantine'})
        self.assertTrue((self.work / 'later.txt').exists())

    def test_rejects_alternates_shared_modules_locks_and_special_content(self):
        facts = archive.inspect(self.request)
        admin = Path(facts['modules'][0]['gitDir'])
        for relative in ('objects/info/alternates', 'commondir', 'index.lock'):
            target = admin / relative
            target.write_text('unsupported')
            try:
                with self.assertRaises(RuntimeError):
                    archive.inspect(self.request)
            finally:
                target.unlink()
        os.mkfifo(self.work / 'pipe')
        with self.assertRaisesRegex(RuntimeError, 'special-file'):
            archive.inspect(self.request)

    def test_refuses_archive_corruption_and_mutual_exclusion(self):
        self.preserve()
        (self.txn / 'archive/working/ignored').write_text('corrupt')
        with self.assertRaisesRegex(RuntimeError, 'archive-changed'):
            archive.verify(self.request)
        held = archive.lock_file(self.txn, 'backend.lock')
        try:
            with self.assertRaisesRegex(RuntimeError, 'backend-busy'):
                archive.lock_file(self.txn, 'backend.lock')
        finally:
            os.close(held)


if __name__ == '__main__':
    unittest.main()
