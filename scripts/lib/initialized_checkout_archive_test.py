"""Disposable native integration fixtures; never use an installed checkout."""
import importlib.util
import copy
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('initialized_checkout_archive.py'))
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)


class CopyMetadata(unittest.TestCase):
    def test_only_new_provenance_is_recorded_and_original_evidence_is_exact(self):
        source = {'path': 'evidence', 'kind': 'file', 'sha256': 'a' * 64,
                  'mode': 0o600, 'xattrs': {'fixture.original': 'b' * 64}}
        copied = {**source, 'xattrs': {**source['xattrs'], 'com.apple.provenance': 'c' * 64}}
        self.assertEqual(archive.copy_augmentations([copied], [source]),
                         [{'path': 'evidence', 'xattrs': {'com.apple.provenance': 'c' * 64}}])
        self.assertEqual(archive.copy_augmentations([source], [source]), [])
        for invalid in (
            {**copied, 'sha256': 'd' * 64},
            {**copied, 'mode': 0o644},
            {**copied, 'path': 'other'},
            {**copied, 'xattrs': {'com.apple.provenance': 'c' * 64}},
            {**copied, 'xattrs': {**copied['xattrs'], 'fixture.original': 'd' * 64}},
            {**copied, 'xattrs': {**copied['xattrs'], 'unknown.attribute': 'd' * 64}},
            {**copied, 'xattrs': {**copied['xattrs'], 'com.apple.provenance': 'invalid'}},
        ):
            with self.subTest(invalid=invalid):
                self.assertIsNone(archive.copy_augmentations([invalid], [source]))
        for invalid in (source, {**copied, 'xattrs': {**copied['xattrs'], 'com.apple.provenance': 'd' * 64}}):
            self.assertIsNone(archive.copy_augmentations([invalid], [copied]))
        self.assertIsNone(archive.copy_augmentations([], [source]))

    def test_replacement_requires_canonical_exact_original_bytes_and_only_provenance(self):
        original = b'original provenance'
        encoded = archive.base64.b64encode(original).decode('ascii')
        source = {'path': '', 'kind': 'directory', 'mode': 0o700,
                  'xattrs': {'com.apple.provenance': archive.hashlib.sha256(original).hexdigest(), 'fixture.original': 'b' * 64}}
        copied = {**source, 'xattrs': {**source['xattrs'], 'com.apple.provenance': 'c' * 64}}
        record = {'path': '', 'xattrs': {'com.apple.provenance': 'c' * 64},
                  'originalBase64': {'com.apple.provenance': encoded}}
        self.assertEqual(archive.copy_augmentations([copied], [source], {'': encoded}), [record])
        self.assertIsNone(archive.copy_augmentations([copied], [source]))  # v1/v2 stay strict.
        for invalid in ('', encoded + '\n', encoded.rstrip('='), 'not base64', archive.base64.b64encode(b'wrong').decode('ascii')):
            with self.subTest(invalid=invalid):
                self.assertIsNone(archive.copy_augmentations([copied], [source], {'': invalid}))
        for invalid in (
            {**copied, 'xattrs': {'fixture.original': 'b' * 64}},
            {**copied, 'xattrs': {**copied['xattrs'], 'fixture.original': 'd' * 64}},
            {**copied, 'xattrs': {**copied['xattrs'], 'fixture.new': 'e' * 64}},
            {**copied, 'mode': 0o755},
        ):
            self.assertIsNone(archive.copy_augmentations([invalid], [source], {'': encoded}))
        self.assertEqual(archive.copy_augmentations([source], [source], {'': encoded}), [])


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
        proof = archive.preserve(self.request)
        self.request['manifestSha256'] = proof['manifestSha256']
        return proof

    def test_admission_bookkeeping_does_not_change_source_review(self):
        before = archive.inspect(self.request)
        admission = Path(before['commonGitDir']) / 'portos-checkout-admission'
        admission.mkdir(mode=0o700)
        (admission / 'writer.lock').write_text('owned service bookkeeping')
        self.assertEqual(archive.inspect(self.request), before)

    def test_unbound_cancellation_accepts_shared_updates_without_touching_originals_or_evidence(self):
        before = archive.inspect(self.request, full=True)
        self.request['expected'] = {k: v for k, v in before.items() if k != 'sources'}
        archive.private_json(self.txn / 'source.json', before)
        (self.txn / 'quarantine').mkdir(mode=0o700)
        (self.txn / 'partial-copy').write_bytes(b'incomplete evidence')
        objects = Path(before['commonGitDir']) / 'objects'
        info = objects.stat()
        os.utime(objects, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000000))
        self.git(self.repo, 'update-ref', 'refs/heads/independent-work', 'HEAD')
        observed = archive.inspect(self.request, full=True)
        proof = archive.verify_unmoved_preservation(self.request)
        self.assertTrue(proof['verified'])
        self.assertTrue(proof['originalsUnmoved'])
        self.assertFalse(proof['archiveVerified'])
        self.assertNotEqual(proof['sharedBeforeSha256'], proof['sharedAfterSha256'])
        self.assertEqual(archive.inspect(self.request, full=True), observed)
        self.assertEqual((self.txn / 'partial-copy').read_bytes(), b'incomplete evidence')
        self.assertFalse((self.txn / 'manifest.json').exists())
        # Changes to original bytes or placement never borrow this exception.
        for target, content, refusal in (
            (self.work / 'new-data', b'new work', 'preservation-original-content-changed'),
            (self.txn / 'quarantine' / 'working', b'move evidence', 'preservation-originals-may-have-moved'),
            (self.txn / 'manifest.json', b'bound proof', 'preservation-already-bound'),
        ):
            with self.subTest(refusal=refusal):
                parent_time = target.parent.stat()
                target.write_bytes(content)
                with self.assertRaisesRegex(RuntimeError, refusal):
                    archive.verify_unmoved_preservation(self.request)
                target.unlink()
                os.utime(target.parent, ns=(parent_time.st_atime_ns, parent_time.st_mtime_ns))
        saved = (self.txn / 'source.json').read_bytes()
        tampered = copy.deepcopy(before)
        tampered['sources']['working'][0]['mode'] ^= 1
        (self.txn / 'source.json').write_text(json.dumps(tampered))
        with self.assertRaisesRegex(RuntimeError, 'preservation-source-proof-changed'):
            archive.verify_unmoved_preservation(self.request)
        (self.txn / 'source.json').write_bytes(saved)
        self.assertTrue(archive.verify_unmoved_preservation(self.request)['verified'])
        self.git(self.repo, 'update-ref', 'refs/heads/feature/fixture', 'HEAD^')
        with self.assertRaisesRegex(RuntimeError, 'release-head-or-branch-changed'):
            archive.verify_unmoved_preservation(self.request)

    def test_common_runtime_sockets_are_outside_capture_but_private_and_captured_sockets_hold(self):
        facts = archive.inspect(self.request)
        common = Path(facts['commonGitDir'])
        private = Path(facts['privateGitDir'])
        # Relative bind avoids Darwin's short AF_UNIX path limit. No daemon is
        # started; sockets and stores belong exclusively to this fixture.
        def bind(path):
            listener = socket.socket(socket.AF_UNIX)
            self.addCleanup(listener.close)
            previous = Path.cwd()
            try:
                os.chdir(path.parent)
                listener.bind(path.name)
            finally:
                os.chdir(previous)
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

    def test_recorded_copy_provenance_is_strict_on_archive_and_restore_rechecks(self):
        raw = archive.raw_xattrs
        change = {'mode': None}
        def observed(path):
            attrs = raw(path)
            if path.is_relative_to(self.txn / 'archive') or path.is_relative_to(self.txn / 'restore'):
                # Simulate the OS copy augmentation at the metadata observation
                # boundary; never set/remove provenance on the real filesystem.
                if path != self.txn / 'archive/working/ignored':
                    attrs = {**attrs, 'com.apple.provenance': b'copy provenance'}
                if path == self.txn / 'archive/working/base.txt':
                    if change['mode'] == 'missing':
                        attrs = {key: value for key, value in attrs.items() if key != 'com.apple.provenance'}
                    if change['mode'] == 'changed':
                        attrs = {**attrs, 'com.apple.provenance': b'changed'}
                    if change['mode'] == 'unknown':
                        attrs = {**attrs, 'fixture.unrecorded': b'unrecorded'}
                if path == self.txn / 'archive/working/ignored' and change['mode'] == 'new':
                    attrs = {**attrs, 'com.apple.provenance': b'late addition'}
                if path == self.txn / 'restore/working/ignored' and change['mode'] == 'restore':
                    attrs = {**attrs, 'com.apple.provenance': b'changed restore'}
            return attrs
        original = archive.inspect(self.request)
        module_config = Path(original['privateGitDir']) / original['modules'][0]['administrationPath'] / 'config'
        subprocess.run(['/usr/bin/xattr', '-w', 'fixture.module.config', 'inherited', str(module_config)], check=True)
        original = archive.inspect(self.request)
        with patch.object(archive, 'raw_xattrs', observed):
            self.preserve()
            saved = json.loads((self.txn / 'manifest.json').read_text())
            self.assertEqual(saved['version'], 3)
            self.assertTrue(saved['copyAugmentations']['archive']['working'])
            config_path = original['modules'][0]['administrationPath'] + '/config'
            copied_config = next(row for row in saved['restored']['administration'] if row['path'] == config_path)
            self.assertEqual(copied_config['xattrs']['fixture.module.config'], archive.hashlib.sha256(b'inherited').hexdigest())
            self.assertEqual(copied_config['xattrs']['com.apple.provenance'], archive.hashlib.sha256(b'copy provenance').hexdigest())
            self.assertEqual(saved['copyAugmentations']['restore']['working'][0]['path'], 'ignored')
            self.assertEqual(archive.inspect(self.request), original)
            self.assertTrue(archive.verify(self.request)['verified'])
            self.assertTrue(archive.verify({**self.request, 'mode': 'standalone'})['standalone'])
            for mode in ('removed-record', 'changed-hash', 'new-record'):
                altered = copy.deepcopy(saved)
                rows = altered['copyAugmentations']['archive']['working']
                if mode == 'removed-record':
                    rows.pop()
                elif mode == 'changed-hash':
                    rows[0]['xattrs']['com.apple.provenance'] = '0' * 64
                else:
                    rows.append({'path': 'unrecorded', 'xattrs': {'com.apple.provenance': '0' * 64}})
                with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'archive-changed'):
                    archive.verify_saved_archive(self.txn, altered)
            for mode in ('missing', 'changed', 'unknown', 'new', 'restore'):
                change['mode'] = mode
                with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'archive-changed|restore-proof-changed|restore-copy-augmentation-changed'):
                    archive.verify({**self.request, 'mode': 'standalone'})
            change['mode'] = None
            with self.assertRaisesRegex(RuntimeError, 'archive-manifest-proof-changed'):
                archive.verify({key: value for key, value in self.request.items() if key != 'manifestSha256'})
            manifest_path = self.txn / 'manifest.json'
            original_manifest = manifest_path.read_bytes()
            altered = copy.deepcopy(saved)
            for row in altered['copyAugmentations']['archive']['working']:
                if row['path'] == 'base.txt':
                    row['xattrs']['com.apple.provenance'] = archive.hashlib.sha256(b'changed').hexdigest()
            manifest_path.write_text(json.dumps(altered))
            change['mode'] = 'changed'
            try:
                with self.assertRaisesRegex(RuntimeError, 'archive-manifest-proof-changed'):
                    archive.verify({**self.request, 'mode': 'standalone'})
            finally:
                manifest_path.write_bytes(original_manifest)
                change['mode'] = None
            for part in ('working', 'administration'):
                archive.move({**self.request, 'part': part, 'direction': 'quarantine'})
            self.assertEqual(archive.manifest(self.txn / 'quarantine/working'), saved['facts']['sources']['working'])
            for part in ('administration', 'working'):
                archive.move({**self.request, 'part': part, 'direction': 'restore'})
            self.assertEqual(archive.inspect(self.request), original)

    def test_manifest_proof_binds_exact_written_and_parsed_bytes(self):
        # Simulate replacement after the producer fsync: the returned proof must
        # still describe the saved bytes, and consuming the replacement holds.
        original_sync = archive.fsync_dir
        changed = {'done': False, 'written': None}
        path = self.txn / 'manifest.json'
        def replace_after_write(directory):
            original_sync(directory)
            if directory == self.txn and path.exists() and not changed['done']:
                changed['done'] = True
                changed['written'] = path.read_bytes()
                path.write_bytes(changed['written'] + b' ')
        with patch.object(archive, 'fsync_dir', replace_after_write):
            proof = self.preserve()
        self.assertEqual(proof['manifestSha256'], archive.hashlib.sha256(changed['written']).hexdigest())
        with self.assertRaisesRegex(RuntimeError, 'archive-manifest-proof-changed'):
            archive.load_transaction(self.request)
        path.write_bytes(changed['written'])
        original_loads = json.loads
        replacement = changed['written'] + b' '
        def replace_after_read(encoded):
            path.write_bytes(replacement)
            return original_loads(encoded)
        # A digest from a later path read must not bless earlier parsed bytes.
        with patch.object(archive.json, 'loads', replace_after_read), self.assertRaisesRegex(RuntimeError, 'archive-manifest-proof-changed'):
            archive.load_transaction({**self.request, 'manifestSha256': archive.hashlib.sha256(replacement).hexdigest()})

    def test_v3_preserves_replaced_common_and_module_provenance_without_installing_attributes(self):
        original = archive.inspect(self.request, full=True)
        module_relative = original['modules'][0]['administrationPath'] + '/config'
        common = Path(original['commonGitDir'])
        admin = Path(original['privateGitDir'])
        raw = archive.raw_xattrs
        values = {
            common / 'info': b'original common provenance',
            admin / module_relative: b'original module provenance',
            self.txn / 'quarantine/administration' / module_relative: b'original module provenance',
            self.txn / 'archive/common/info': b'archive common provenance',
            self.txn / 'archive/administration' / module_relative: b'archive module provenance',
            self.txn / 'restore/common/info': b'restore common provenance',
            self.txn / 'restore/administration' / module_relative: b'restore module provenance',
        }
        def observed(path):
            attrs = raw(path)
            return {**attrs, 'com.apple.provenance': values[path]} if path in values else attrs
        with patch.object(archive, 'raw_xattrs', observed):
            proof = self.preserve()
            saved = json.loads((self.txn / 'manifest.json').read_text())
            self.assertEqual(saved['version'], 3)
            rows = saved['copyAugmentations']
            archived = rows['archive']['common']['info'][0]
            self.assertEqual(archived['path'], '')
            self.assertEqual(archive.provenance_value(archived['originalBase64']['com.apple.provenance']), values[common / 'info'])
            restored = next(row for row in rows['restore']['common'] if row['path'] == 'info')
            self.assertEqual(archive.provenance_value(restored['originalBase64']['com.apple.provenance']), values[self.txn / 'archive/common/info'])
            module = next(row for row in rows['archive']['administration'] if row['path'] == module_relative)
            self.assertEqual(archive.provenance_value(module['originalBase64']['com.apple.provenance']), values[admin / module_relative])
            self.assertTrue(archive.verify(self.request)['verified'])
            for version in (1, 2):
                altered = {**saved, 'version': version}
                with self.subTest(version=version), self.assertRaisesRegex(RuntimeError, 'archive-changed|restore-copy-augmentation-changed'):
                    archive.verify_saved_archive(self.txn, altered)
            for change in ('missing', 'wrong', 'extra-key', 'duplicate', 'unchanged-copy'):
                altered = copy.deepcopy(saved)
                entries = altered['copyAugmentations']['archive']['common']['info']
                entry = entries[0]
                if change == 'missing':
                    del entry['originalBase64']
                elif change == 'wrong':
                    entry['originalBase64']['com.apple.provenance'] = archive.base64.b64encode(b'wrong').decode('ascii')
                elif change == 'extra-key':
                    entry['originalBase64']['fixture.other'] = ''
                elif change == 'duplicate':
                    entries.append(copy.deepcopy(entry))
                else:
                    entry['xattrs']['com.apple.provenance'] = saved['facts']['sources']['common']['info'][0]['xattrs']['com.apple.provenance']
                with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'common-archive-changed|invalid-provenance-preimage-layout'):
                    archive.verify_saved_archive(self.txn, altered)
            # Altered preimages cannot be re-bound by editing the manifest.
            altered = copy.deepcopy(saved)
            altered['copyAugmentations']['archive']['common']['info'][0]['originalBase64']['com.apple.provenance'] = ''
            path = self.txn / 'manifest.json'
            preserved_bytes = path.read_bytes()
            path.write_text(json.dumps(altered))
            with self.assertRaisesRegex(RuntimeError, 'archive-manifest-proof-changed'):
                archive.verify(self.request)
            path.write_bytes(preserved_bytes)
            self.assertEqual(proof['manifestSha256'], archive.sha(path))
            values[common / 'info'] = b'changed source'
            with self.assertRaisesRegex(RuntimeError, 'common-store-changed'):
                archive.verify(self.request)
            values[common / 'info'] = b'original common provenance'
            for part in ('working', 'administration'):
                archive.move({**self.request, 'part': part, 'direction': 'quarantine'})
            self.assertTrue(archive.verify(self.request)['verified'])
            # Recovery proof stays self-contained after live common storage is unavailable.
            common.rename(self.repo / '.git-unavailable')
            self.assertTrue(archive.verify({**self.request, 'mode': 'standalone'})['standalone'])

    def test_version_two_keeps_additions_but_refuses_existing_provenance_replacement(self):
        self.preserve()
        path = self.txn / 'manifest.json'
        saved = json.loads(path.read_text())
        saved['version'] = 2
        path.write_text(json.dumps(saved))
        self.request['manifestSha256'] = archive.sha(path)
        self.assertTrue(archive.verify(self.request)['verified'])
        raw = archive.raw_xattrs
        def added(path):
            attrs = raw(path)
            return {**attrs, 'com.apple.provenance': b'unrecorded'} if path == self.txn / 'archive/working/base.txt' else attrs
        with patch.object(archive, 'raw_xattrs', added), self.assertRaisesRegex(RuntimeError, 'archive-changed|restore-copy-augmentation-changed'):
            archive.verify({**self.request, 'mode': 'standalone'})

    def test_version_one_archive_does_not_accept_unrecorded_copy_provenance(self):
        self.preserve()
        saved = json.loads((self.txn / 'manifest.json').read_text())
        self.assertFalse(any(saved['copyAugmentations']['archive'][part]
                             for part in ('working', 'administration')))
        self.assertFalse(any(saved['copyAugmentations']['archive']['common'].values()))
        saved['version'] = 1
        del saved['copyAugmentations']
        (self.txn / 'manifest.json').write_text(json.dumps(saved))
        with self.assertRaisesRegex(RuntimeError, 'archive-manifest-proof-changed'):
            archive.verify(self.request)
        del self.request['manifestSha256']  # Genuine legacy callers have no bound v2 proof.
        self.assertTrue(archive.verify(self.request)['verified'])
        raw = archive.raw_xattrs
        def augmented(path):
            attrs = raw(path)
            return {**attrs, 'com.apple.provenance': b'unrecorded'} if path == self.txn / 'archive/working/base.txt' else attrs
        with patch.object(archive, 'raw_xattrs', augmented), self.assertRaisesRegex(RuntimeError, 'archive-changed'):
            archive.verify({**self.request, 'mode': 'standalone'})

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

    def metadata_recovery_fixture(self):
        subprocess.run(['/usr/bin/xattr', '-w', 'com.apple.decmpfs', 'fixture-residual',
                        str(self.work / 'base.txt')], check=True)
        self.preserve()
        before = (self.txn / 'manifest.json').read_bytes()
        archive.move({**self.request, 'part': 'working', 'direction': 'quarantine'})
        moved = self.txn / 'quarantine/working/base.txt'
        # This deliberately mutates only the new disposable fixture to reproduce
        # metadata removal after rename; recovery never performs an xattr write.
        if 'com.apple.decmpfs' in archive.raw_xattrs(moved):
            subprocess.run(['/usr/bin/xattr', '-d', 'com.apple.decmpfs', str(moved)], check=True)
        with self.assertRaisesRegex(RuntimeError, 'source-content-or-identity-changed'):
            archive.verify({**self.request, 'mode': 'restore'})
        return before

    def test_metadata_recovery_preserves_preimages_and_restores_same_inodes_across_processes(self):
        before = self.metadata_recovery_fixture()
        def process(request):
            result = subprocess.run([sys.executable, str(Path(archive.__file__))],
                                    input=json.dumps(request) + '\n', env=self.env,
                                    capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
        review = process({**self.request, 'command': 'review-metadata-recovery'})
        proof = review['metadataRecovery']
        evidence_path = self.txn / proof['evidenceFile']
        evidence = json.loads(evidence_path.read_text())
        self.assertEqual(archive.sha(evidence_path), proof['evidenceSha256'])
        self.assertEqual(archive.digest(evidence), proof['digest'])
        removed = next(row for row in evidence['changes'] if row['attribute'] == 'com.apple.decmpfs')
        self.assertEqual(archive.base64.b64decode(removed['beforeBase64']), b'fixture-residual')
        self.assertEqual(review['initialPlacements'], {'working': 'quarantine', 'administration': 'original'})
        accepted = {**self.request, 'metadataRecovery': proof}
        for request in ({**accepted, 'command': 'verify'},
                        {**accepted, 'command': 'move', 'part': 'working', 'direction': 'quarantine'}):
            result = subprocess.run([sys.executable, str(Path(archive.__file__))],
                                    input=json.dumps(request) + '\n', env=self.env,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['reason'], 'metadata-recovery-restore-only')
        unchanged_identity = archive.identity(self.txn / 'quarantine/working')
        self.assertTrue(process({**accepted, 'command': 'move', 'part': 'administration',
                                 'direction': 'restore'})['alreadyRestored'])
        moved = process({**accepted, 'command': 'move', 'part': 'working', 'direction': 'restore'})
        observation = moved['postMoveObservation']
        self.assertEqual(archive.sha(self.txn / observation['file']), observation['sha256'])
        self.assertTrue(process({**accepted, 'command': 'verify', 'mode': 'restore'})['metadataRecoveryAccepted'])
        self.assertEqual(archive.identity(self.work), unchanged_identity)
        self.assertNotIn('com.apple.decmpfs', archive.raw_xattrs(self.work / 'base.txt'))
        self.assertEqual(archive.raw_xattrs(self.txn / 'archive/working/base.txt')['com.apple.decmpfs'], b'fixture-residual')
        self.assertEqual((self.txn / 'manifest.json').read_bytes(), before)
        self.assertTrue(archive.verify({**self.request, 'mode': 'standalone'})['standalone'])
        self.assertEqual(self.git(self.work, 'rev-parse', 'HEAD'), self.request['release']['head'])
        # The old transaction remains exact rather than silently adopting the
        # reviewed transition as its new default source baseline.
        with self.assertRaisesRegex(RuntimeError, 'source-content-or-identity-changed'):
            archive.verify({**self.request, 'mode': 'restore'})

    def test_metadata_recovery_publishes_complete_evidence_without_overwriting_interrupted_or_foreign_records(self):
        before = self.metadata_recovery_fixture()
        write = archive.private_json
        partial = []
        def interrupt_staging(path, evidence):
            if path.name.endswith('.staging'):
                with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
                    out.write(b'{"interrupted":')
                    out.flush()
                    os.fsync(out.fileno())
                partial.append(path)
                raise RuntimeError('fixture interrupted staging write')
            return write(path, evidence)
        with patch.object(archive, 'private_json', interrupt_staging):
            with self.assertRaisesRegex(RuntimeError, 'fixture interrupted staging'):
                archive.review_metadata_recovery(self.request)
        self.assertEqual(list(self.txn.glob('metadata-recovery-*.json')), [])
        reviewed = archive.review_metadata_recovery(self.request)
        evidence_path = self.txn / reviewed['metadataRecovery']['evidenceFile']
        self.assertEqual(archive.sha(evidence_path), reviewed['metadataRecovery']['evidenceSha256'])
        self.assertEqual(partial[0].read_bytes(), b'{"interrupted":')
        self.assertEqual((self.txn / 'manifest.json').read_bytes(), before)
        self.assertTrue(archive.verify({**self.request, 'mode': 'restore',
                                       'metadataRecovery': reviewed['metadataRecovery']})['verified'])

        rename = archive.exclusive_rename
        evidence = {'fixture': 'concurrent complete evidence'}
        def racing_publication(staged, destination):
            write(destination, evidence)
            return rename(staged, destination)
        with patch.object(archive, 'exclusive_rename', racing_publication):
            shared = archive.immutable_recovery_evidence(self.txn, 'fixture-concurrent-', evidence)
        self.assertEqual(json.loads((self.txn / shared['file']).read_text()), evidence)
        self.assertEqual(len(list(self.txn.glob('.fixture-concurrent-*.staging'))), 1)
        foreign = {'fixture': 'foreign evidence, retain unchanged'}
        def conflicting_publication(staged, destination):
            write(destination, foreign)
            return rename(staged, destination)
        with patch.object(archive, 'exclusive_rename', conflicting_publication):
            with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-evidence-changed'):
                archive.immutable_recovery_evidence(self.txn, 'fixture-conflicting-', evidence)
        collision = self.txn / ('fixture-conflicting-' + archive.digest(evidence) + '.json')
        self.assertEqual(json.loads(collision.read_text()), foreign)
        self.assertEqual(len(list(self.txn.glob('.fixture-conflicting-*.staging'))), 1)

    def test_metadata_recovery_rejects_stale_review_and_unclassified_source_changes(self):
        self.metadata_recovery_fixture()
        review = archive.review_metadata_recovery(self.request)
        accepted = {**self.request, 'mode': 'restore', 'metadataRecovery': review['metadataRecovery']}
        original_manifest = archive.manifest
        def observe(patch_row):
            def observed(path, reject_links=False):
                rows = original_manifest(path, reject_links)
                if path == self.txn / 'quarantine/working':
                    rows = copy.deepcopy(rows)
                    row = next(value for value in rows if value['path'] == 'base.txt')
                    patch_row(row)
                return rows
            return observed
        mutations = {
            'content': lambda row: row.update(sha256='0' * 64),
            'mode': lambda row: row.update(mode=row['mode'] ^ 0o100),
            'flags': lambda row: row.update(flags=row['flags'] | 0x20),
            'acl': lambda row: row.update(acl='changed'),
            'identity': lambda row: row['filesystemIdentity'].update(ino=0),
            'security attribute': lambda row: row['xattrs'].update({'com.apple.quarantine': '0' * 64}),
            'nonroot provenance': lambda row: row['xattrs'].update({'com.apple.provenance': '0' * 64}),
        }
        for name, mutation in mutations.items():
            with self.subTest(change=name), patch.object(archive, 'manifest', observe(mutation)):
                with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-review-changed'):
                    archive.verify(accepted)
                with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-source-content-or-identity-changed|metadata-recovery-unsupported-attribute-change'):
                    archive.review_metadata_recovery(self.request)
        evidence_path = self.txn / review['metadataRecovery']['evidenceFile']
        encoded = evidence_path.read_bytes()
        evidence_path.write_bytes(encoded + b' ')
        with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-evidence-changed'):
            archive.verify(accepted)
        evidence_path.write_bytes(encoded)
        attrs = archive.raw_xattrs
        def changed_preimage(path):
            values = attrs(path)
            return {**values, 'com.apple.decmpfs': b'wrong'} if path == self.txn / 'archive/working/base.txt' else values
        with patch.object(archive, 'raw_xattrs', changed_preimage):
            with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-preimage-missing-or-changed'):
                archive.verify(accepted)
        self.assertFalse(self.work.exists())
        self.assertTrue((self.txn / 'quarantine/working/base.txt').exists())

    def test_metadata_recovery_records_unexpected_postmove_change_and_requires_new_review(self):
        before = self.metadata_recovery_fixture()
        first = archive.review_metadata_recovery(self.request)
        attrs = archive.raw_xattrs
        def moved_provenance(path):
            values = attrs(path)
            # Model a platform-generated root-only addition observed after the
            # exclusive rename, without writing security metadata on any file.
            return {**values, 'com.apple.provenance': b'postmove provenance'} if path == self.work else values
        with patch.object(archive, 'raw_xattrs', moved_provenance):
            with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-postmove-changed:'):
                archive.move({**self.request, 'metadataRecovery': first['metadataRecovery'],
                              'part': 'working', 'direction': 'restore'})
            observations = list(self.txn.glob('metadata-recovery-postmove-*.json'))
            self.assertEqual(len(observations), 1)
            self.assertTrue(self.work.exists())
            self.assertFalse((self.txn / 'quarantine/working').exists())
            with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-review-changed'):
                archive.verify({**self.request, 'mode': 'restore',
                                'metadataRecovery': first['metadataRecovery']})
            refreshed = archive.review_metadata_recovery(self.request)
            self.assertNotEqual(refreshed['metadataRecovery']['digest'], first['metadataRecovery']['digest'])
            self.assertEqual(refreshed['changeCounts']['rootProvenanceAdded'], 1)
            accepted = {**self.request, 'metadataRecovery': refreshed['metadataRecovery']}
            self.assertTrue(archive.move({**accepted, 'part': 'working', 'direction': 'restore'})['alreadyRestored'])
            self.assertTrue(archive.verify({**accepted, 'mode': 'restore'})['metadataRecoveryAccepted'])
        self.assertEqual((self.txn / 'manifest.json').read_bytes(), before)

    def restored_finalization_fixture(self, move_administration=False):
        subprocess.run(['/usr/bin/xattr', '-w', 'com.apple.decmpfs', 'fixture-residual',
                        str(self.work / 'base.txt')], check=True)
        self.preserve()
        for part in (('administration', 'working') if move_administration else ('working',)):
            archive.move({**self.request, 'part': part, 'direction': 'quarantine'})
        moved = self.txn / 'quarantine/working/base.txt'
        if 'com.apple.decmpfs' in archive.raw_xattrs(moved):
            subprocess.run(['/usr/bin/xattr', '-d', 'com.apple.decmpfs', str(moved)], check=True)
        review = archive.review_metadata_recovery(self.request)
        request = {**self.request, 'metadataRecovery': review['metadataRecovery']}
        observations = [archive.move({**request, 'part': part, 'direction': 'restore'}).get('postMoveObservation')
                        for part in ('administration', 'working')]
        self.assertTrue(archive.verify({**request, 'mode': 'restore'})['verified'])
        # Actual disposable-file operations reproduce a delayed reappearance and
        # directory timestamp change after both original-inode moves succeeded.
        subprocess.run(['/usr/bin/xattr', '-w', 'com.apple.decmpfs', 'fixture-residual',
                        str(self.work / 'base.txt')], check=True)
        directory = self.work / 'empty'
        info = directory.stat()
        os.utime(directory, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
        return {**request, 'postMoveObservations': observations}

    def test_restored_finalization_records_delayed_metadata_without_moving_or_rewriting_originals(self):
        request = self.restored_finalization_fixture()
        baseline = (self.txn / 'manifest.json').read_bytes()
        before = archive.original_sources(self.txn, archive.load_transaction(request)[1]['facts'])
        with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-review-changed'):
            archive.verify({**request, 'mode': 'restore'})
        result = subprocess.run([sys.executable, str(Path(archive.__file__))],
                                input=json.dumps({**request, 'command': 'review-restored-finalization'}) + '\n',
                                env=self.env, capture_output=True, text=True, check=True)
        reviewed = json.loads(result.stdout)
        self.assertEqual(reviewed['changeCounts'], {'directoryMtimeChanged': 1, 'residualCompressionReappeared': 1})
        accepted = {**request, 'restoredFinalization': reviewed['restoredFinalization']}
        evidence = json.loads((self.txn / reviewed['restoredFinalization']['evidenceFile']).read_text())
        returned = next(row for row in evidence['changes'] if row.get('attribute') == 'com.apple.decmpfs')
        self.assertEqual(archive.base64.b64decode(returned['originalBase64']), b'fixture-residual')
        self.assertEqual(returned['afterBase64'], returned['originalBase64'])
        with patch.object(archive, 'exclusive_rename', side_effect=AssertionError('no move allowed')):
            self.assertTrue(archive.verify_restored_finalization(accepted)['restoredFinalizationAccepted'])
            self.assertTrue(archive.verify_restored_finalization(accepted)['alreadyRestored'])
        for command in ({'command': 'verify', 'mode': 'restore'},
                        {'command': 'move', 'direction': 'restore', 'part': 'working'}):
            result = subprocess.run([sys.executable, str(Path(archive.__file__))],
                                    input=json.dumps({**accepted, **command}) + '\n',
                                    env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['reason'], 'restored-finalization-separate-command-required')
        self.assertEqual(archive.original_sources(self.txn, archive.load_transaction(request)[1]['facts']), before)
        self.assertEqual((self.txn / 'manifest.json').read_bytes(), baseline)
        self.assertTrue(archive.verify({**self.request, 'mode': 'standalone'})['standalone'])

    def test_restored_finalization_refuses_stale_snapshot_and_noneligible_changes(self):
        request = self.restored_finalization_fixture()
        review = archive.review_restored_finalization(request)
        accepted = {**request, 'restoredFinalization': review['restoredFinalization']}
        original_manifest = archive.manifest
        mutations = {
            'content': lambda row: row.update(sha256='0' * 64),
            'file mtime': lambda row: row.update(mtimeNs=row['mtimeNs'] + 1),
            'flags': lambda row: row.update(flags=row['flags'] | 0x20),
            'ownership': lambda row: row.update(uid=row['uid'] + 1),
            'acl': lambda row: row.update(acl='changed'),
            'identity': lambda row: row['filesystemIdentity'].update(ino=0),
            'security attribute': lambda row: row['xattrs'].update({'com.apple.quarantine': '0' * 64}),
            'wrong compression': lambda row: row['xattrs'].update({'com.apple.decmpfs': '0' * 64}),
        }
        for name, mutation in mutations.items():
            def observe(path, reject_links=False):
                rows = original_manifest(path, reject_links)
                if path == self.work:
                    rows = copy.deepcopy(rows)
                    mutation(next(row for row in rows if row['path'] == 'base.txt'))
                return rows
            with self.subTest(change=name), patch.object(archive, 'manifest', observe):
                with self.assertRaisesRegex(RuntimeError, 'restored-finalization-source-content-or-identity-changed|restored-finalization-unsupported-attribute-change'):
                    archive.review_restored_finalization(request)
        directory = self.work / 'empty'
        info = directory.stat()
        os.utime(directory, ns=(info.st_atime_ns, info.st_mtime_ns + 1))
        with self.assertRaisesRegex(RuntimeError, 'restored-finalization-review-changed'):
            archive.verify_restored_finalization(accepted)
        refreshed = archive.review_restored_finalization(request)
        self.assertNotEqual(refreshed['restoredFinalization']['digest'], review['restoredFinalization']['digest'])
        self.assertTrue(archive.verify_restored_finalization(
            {**request, 'restoredFinalization': refreshed['restoredFinalization']})['verified'])

    def test_restored_finalization_requires_exact_prior_observations_and_raw_preimages(self):
        request = self.restored_finalization_fixture(move_administration=True)
        self.assertTrue(archive.review_restored_finalization(request)['restoredFinalization'])
        for references in ([], request['postMoveObservations'][::-1],
                           [request['postMoveObservations'][0]] * 2,
                           [None, request['postMoveObservations'][1]],
                           [request['postMoveObservations'][0], None]):
            with self.subTest(references=references), self.assertRaisesRegex(RuntimeError, 'restored-finalization-postmove-proof|restored-finalization-evidence-invalid'):
                archive.review_restored_finalization({**request, 'postMoveObservations': references})
        reference = request['postMoveObservations'][0]
        path = self.txn / reference['file']
        encoded = path.read_bytes()
        path.write_bytes(encoded + b' ')
        with self.assertRaisesRegex(RuntimeError, 'restored-finalization-evidence-changed'):
            archive.review_restored_finalization(request)
        path.write_bytes(encoded)
        attributes = archive.raw_xattrs
        def invalid_raw(path):
            values = attributes(path)
            return {**values, 'com.apple.decmpfs': b'wrong'} if path == self.work / 'base.txt' else values
        # Keep the observed manifest hashes stable to isolate the separate raw
        # preimage check against a racing attribute read.
        manifest = archive.manifest(self.work)
        real_manifest = archive.manifest
        def stable_manifest(path, reject_links=False):
            return manifest if path == self.work else real_manifest(path, reject_links)
        with patch.object(archive, 'raw_xattrs', invalid_raw), patch.object(archive, 'manifest', stable_manifest):
            with self.assertRaisesRegex(RuntimeError, 'restored-finalization-preimage-missing-or-changed'):
                archive.review_restored_finalization(request)
        archive.exclusive_rename(self.work, self.txn / 'quarantine/working')
        with self.assertRaisesRegex(RuntimeError, 'restored-finalization-original-placement-required'):
            archive.review_restored_finalization(request)

    def quarantine_resumption_fixture(self):
        self.metadata_recovery_fixture()
        reviewed = archive.review_quarantine_resumption(self.request)
        return {**self.request, 'quarantineResumption': reviewed['quarantineResumption']}

    def test_quarantine_resumption_moves_only_original_administration_and_keeps_purposes_separate(self):
        self.metadata_recovery_fixture()
        baseline = (self.txn / 'manifest.json').read_bytes()
        def process(request):
            result = subprocess.run([sys.executable, str(Path(archive.__file__))],
                                    input=json.dumps(request) + '\n', env=self.env,
                                    capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
        reviewed = process({**self.request, 'command': 'review-quarantine-resumption'})
        self.assertEqual(reviewed['initialPlacements'], {'working': 'quarantine', 'administration': 'original'})
        self.assertEqual(reviewed['changeCounts'], {'residualCompressionRemoved': 1, 'rootProvenanceAdded': 0})
        request = {**self.request, 'quarantineResumption': reviewed['quarantineResumption']}
        evidence = json.loads((self.txn / reviewed['quarantineResumption']['evidenceFile']).read_text())
        self.assertEqual(evidence['purpose'], 'resume-initialized-quarantine')
        self.assertEqual(archive.base64.b64decode(evidence['changes'][0]['beforeBase64']), b'fixture-residual')
        self.assertTrue(process({**request, 'command': 'verify-quarantine-resumption'})['verified'])
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-completed-placement-required'):
            archive.verify_completed_quarantine(request)
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-separate-command-required'):
            archive.move({**request, 'part': 'administration', 'direction': 'quarantine'})
        restore = archive.review_metadata_recovery(self.request)['metadataRecovery']
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-evidence-invalid'):
            archive.resume_quarantine({**request, 'quarantineResumption': restore})
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-purpose-mismatch'):
            archive.resume_quarantine({**request, 'restoredFinalization': restore})
        before = archive.original_sources(self.txn, archive.load_transaction(request)[1]['facts'])[1]
        moved = process({**request, 'command': 'resume-quarantine'})
        self.assertTrue(moved['moved'])
        self.assertEqual(moved['part'], 'administration')
        observation = moved['postMoveObservation']
        self.assertEqual(archive.sha(self.txn / observation['file']), observation['sha256'])
        self.assertTrue(process({**request, 'command': 'verify-completed-quarantine'})['verified'])
        with patch.object(archive, 'exclusive_rename', side_effect=AssertionError('must not move twice')):
            self.assertTrue(archive.resume_quarantine(request)['alreadyQuarantined'])
        after = archive.original_sources(self.txn, archive.load_transaction(request)[1]['facts'])[1]
        self.assertEqual(after, before)
        self.assertFalse(self.work.exists())
        self.assertEqual((self.txn / 'manifest.json').read_bytes(), baseline)

    def test_automatic_quarantine_requires_fresh_exact_permit_after_native_verification(self):
        request = {**self.quarantine_resumption_fixture(), 'command': 'resume-quarantine',
                   'mutationPermit': '11111111-1111-1111-1111-111111111111'}
        saved = archive.load_transaction(request)[1]
        source = Path(saved['facts']['privateGitDir'])
        original = archive.identity(source)
        destination = self.txn / 'quarantine/administration'
        for reply in ('', '{}\n', json.dumps({'mutationPermit': request['mutationPermit'], 'allow': False}) + '\n',
                      json.dumps({'mutationPermit': request['mutationPermit'], 'allow': 1}) + '\n'):
            with subprocess.Popen([sys.executable, str(Path(archive.__file__))], env=self.env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True) as child:
                child.stdin.write(json.dumps(request) + '\n')
                child.stdin.flush()
                ready = json.loads(child.stdout.readline())
                self.assertEqual(ready, {'mutationReady': request['mutationPermit'], 'part': 'administration'})
                # This readiness record is emitted after full native verification,
                # while the exact original and backend lock remain in place.
                self.assertEqual(archive.identity(source), original)
                self.assertFalse(destination.exists())
                output, _ = child.communicate(reply, timeout=30)
                self.assertNotEqual(child.returncode, 0)
                self.assertFalse(json.loads(output)['ok'])
            self.assertEqual(archive.identity(source), original)
            self.assertFalse(destination.exists())
        with subprocess.Popen([sys.executable, str(Path(archive.__file__))], env=self.env,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True) as child:
            child.stdin.write(json.dumps(request) + '\n')
            child.stdin.flush()
            self.assertEqual(json.loads(child.stdout.readline())['mutationReady'], request['mutationPermit'])
            output, _ = child.communicate(json.dumps({'mutationPermit': request['mutationPermit'], 'allow': True}) + '\n', timeout=30)
            self.assertEqual(child.returncode, 0, output)
            self.assertTrue(json.loads(output)['moved'])
        self.assertEqual(archive.identity(destination), original)
        self.assertFalse(source.exists())

    def test_quarantine_resumption_recovers_postmove_evidence_interruption_without_replaying_rename(self):
        request = self.quarantine_resumption_fixture()
        write = archive.private_json
        stages = []
        def interrupted(path, evidence):
            if path.name.startswith('.quarantine-resumption-postmove-'):
                with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
                    out.write(b'{"interrupted":')
                    out.flush()
                    os.fsync(out.fileno())
                stages.append(path)
                raise RuntimeError('fixture evidence publication interrupted')
            return write(path, evidence)
        with patch.object(archive, 'private_json', interrupted):
            with self.assertRaisesRegex(RuntimeError, 'fixture evidence publication interrupted'):
                archive.resume_quarantine(request)
        self.assertTrue((self.txn / 'quarantine/administration').exists())
        self.assertFalse(self.work.exists())
        self.assertEqual(list(self.txn.glob('quarantine-resumption-postmove-*.json')), [])
        reviewed = archive.review_quarantine_resumption(self.request)
        self.assertEqual(reviewed['initialPlacements'], {'working': 'quarantine', 'administration': 'quarantine'})
        accepted = {**self.request, 'quarantineResumption': reviewed['quarantineResumption']}
        self.assertNotEqual(accepted['quarantineResumption']['digest'], request['quarantineResumption']['digest'])
        with patch.object(archive, 'exclusive_rename', side_effect=AssertionError('no repeat rename')):
            self.assertTrue(archive.resume_quarantine(accepted)['alreadyQuarantined'])
            self.assertTrue(archive.verify_completed_quarantine(accepted)['verified'])
        self.assertEqual(stages[0].read_bytes(), b'{"interrupted":')

    def test_quarantine_resumption_preserves_new_postmove_delta_and_requires_new_approval(self):
        request = self.quarantine_resumption_fixture()
        attrs = archive.raw_xattrs
        def moved_provenance(path):
            values = attrs(path)
            # Model an OS-generated attribute on the moved disposable directory.
            return {**values, 'com.apple.provenance': b'postmove provenance'} if path == self.txn / 'quarantine/administration' else values
        with patch.object(archive, 'raw_xattrs', moved_provenance):
            with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-postmove-changed:'):
                archive.resume_quarantine(request)
            observations = list(self.txn.glob('quarantine-resumption-postmove-*.json'))
            self.assertEqual(len(observations), 1)
            observed = json.loads(observations[0].read_text())
            self.assertEqual(observed['acceptedQuarantineResumption'], request['quarantineResumption'])
            self.assertEqual(observed['placements']['administration']['state'], 'quarantine')
            with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-review-changed'):
                archive.verify_completed_quarantine(request)
            reviewed = archive.review_quarantine_resumption(self.request)
            self.assertEqual(reviewed['changeCounts']['rootProvenanceAdded'], 1)
            accepted = {**self.request, 'quarantineResumption': reviewed['quarantineResumption']}
            with patch.object(archive, 'exclusive_rename', side_effect=AssertionError('no repeat rename')):
                self.assertTrue(archive.resume_quarantine(accepted)['alreadyQuarantined'])
                self.assertTrue(archive.verify_completed_quarantine(accepted)['verified'])
        self.assertFalse(self.work.exists())

    def test_quarantine_resumption_refuses_nonwhitelisted_drift_and_stale_source_approval(self):
        request = self.quarantine_resumption_fixture()
        original_manifest = archive.manifest
        mutations = {
            'directory mtime': ('', lambda row: row.update(mtimeNs=row['mtimeNs'] + 1)),
            'file bytes': ('base.txt', lambda row: row.update(sha256='0' * 64)),
            'file mtime': ('base.txt', lambda row: row.update(mtimeNs=row['mtimeNs'] + 1)),
            'compression flag': ('base.txt', lambda row: row.update(flags=row['flags'] | 0x20)),
            'security attribute': ('base.txt', lambda row: row['xattrs'].update({'com.apple.quarantine': '0' * 64})),
            'unknown attribute': ('base.txt', lambda row: row['xattrs'].update({'fixture.unknown': '0' * 64})),
        }
        for name, (relative, mutation) in mutations.items():
            def observe(path, reject_links=False):
                rows = original_manifest(path, reject_links)
                if path == self.txn / 'quarantine/working':
                    rows = copy.deepcopy(rows)
                    mutation(next(row for row in rows if row['path'] == relative))
                return rows
            with self.subTest(change=name), patch.object(archive, 'manifest', observe):
                with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-source-content-or-identity-changed|metadata-recovery-unsupported-attribute-change'):
                    archive.review_quarantine_resumption(self.request)
        # Exact original bytes reappearing cannot silently reuse an approval of
        # their absence, even though a fresh baseline-exact review could pass.
        target = self.txn / 'quarantine/working/base.txt'
        subprocess.run(['/usr/bin/xattr', '-w', 'com.apple.decmpfs', 'fixture-residual', str(target)], check=True)
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-review-changed'):
            archive.resume_quarantine(request)
        subprocess.run(['/usr/bin/xattr', '-d', 'com.apple.decmpfs', str(target)], check=True)
        evidence_path = self.txn / request['quarantineResumption']['evidenceFile']
        evidence_path.write_bytes(evidence_path.read_bytes() + b' ')
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-evidence-changed'):
            archive.resume_quarantine(request)
        self.assertFalse((self.txn / 'quarantine/administration').exists())

    def test_retired_quarantine_proves_full_sources_and_receipt_phase_after_branch_deletion(self):
        request = self.quarantine_resumption_fixture()
        archive.resume_quarantine(request)
        receipt = {'journalDigest': 'a' * 64, 'branch': self.request['release']['branch'],
                   'head': self.request['release']['head'], 'phase': 'branch-retired'}
        retired = {**request, 'confirmedDeletion': receipt}
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-retired-branch-not-absent'):
            archive.verify_retired_quarantine(retired)
        common = Path(archive.load_transaction(request)[1]['facts']['commonGitDir'])
        config_before = archive.manifest(common / 'config')
        # Match production's exact-old-OID local receiver. `git branch -d`
        # rewrites config even without a matching stanza and correctly trips
        # the immutable common-store guard; receiver deletion does not.
        ref = 'refs/heads/' + self.request['release']['branch']
        self.git(self.repo, 'push', '--force-with-lease=' + ref + ':' + self.request['release']['head'],
                 self.repo.as_uri(), ':' + ref)
        self.assertEqual(archive.manifest(common / 'config'), config_before)
        with self.assertRaises(RuntimeError):
            archive.verify_completed_quarantine(request)
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-confirmed-deletion-required'):
            archive.verify_retired_quarantine({**retired, 'confirmedDeletion': {**receipt, 'phase': 'retire-branch-intent'}})
        result = subprocess.run([sys.executable, str(Path(archive.__file__))],
                                input=json.dumps({**retired, 'command': 'verify-retired-quarantine'}) + '\n',
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        verified = json.loads(result.stdout)
        self.assertTrue(verified['verified'])
        self.assertEqual(verified['confirmedDeletion'], receipt)
        self.assertTrue(archive.verify_retired_quarantine(
            {**retired, 'confirmedDeletion': {**receipt, 'phase': 'retired'}})['verified'])
        self.assertTrue(archive.verify({**self.request, 'mode': 'standalone'})['standalone'])
        # Only this disposable repository is pruned. Private index/ref objects
        # no longer have live roots after quarantine but remain in the archive.
        self.git(self.repo, 'prune', '--expire=now')
        with self.assertRaises(RuntimeError):
            archive.verify_live_object_closure(self.txn, common)
        self.assertTrue(archive.verify_retired_quarantine(retired)['verified'])
        # A damaged ref in this fixture must not be mistaken for absence by an
        # enumeration command that skips broken entries. Keep the bytes intact.
        broken_ref = common / 'refs/heads' / self.request['release']['branch']
        broken_ref.parent.mkdir(parents=True, exist_ok=True)
        broken_ref.write_text('invalid fixture ref\n')
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-retired-branch-not-absent'):
            archive.verify_retired_quarantine(retired)
        self.assertEqual(broken_ref.read_text(), 'invalid fixture ref\n')
        broken_ref.unlink()
        os.symlink(self.scratch / 'absent-ref-target', broken_ref)
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-retired-branch-not-absent'):
            archive.verify_deleted_branch(retired)
        self.assertTrue(broken_ref.is_symlink())
        broken_ref.unlink()
        broken_ref.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-retired-branch-not-absent'):
            archive.verify_deleted_branch(retired)
        broken_ref.rmdir()
        saved_parent = self.scratch / 'saved-fixture-ref-parent'
        broken_ref.parent.rename(saved_parent)
        os.symlink(saved_parent, broken_ref.parent)
        with self.assertRaisesRegex(RuntimeError, 'quarantine-resumption-retired-branch-not-absent'):
            archive.verify_deleted_branch(retired)
        broken_ref.parent.unlink()
        saved_parent.rename(broken_ref.parent)

        packed = common / 'packed-refs'
        prior_packed = packed.read_bytes() if packed.exists() else None
        head = receipt['head'].encode('ascii')
        target = ('refs/heads/' + receipt['branch']).encode('ascii')
        for content in (head + b' ' + target + b' extra\n',
                        b'invalid ' + target + b'\n',
                        b'0' * len(head) + b' ' + target + b'\n',
                        head + b' ' + target + b'\n'):
            packed.write_bytes(content)
            with self.subTest(packed=content), self.assertRaisesRegex(RuntimeError, 'deleted-branch-packed-refs-malformed|quarantine-resumption-retired-branch-not-absent'):
                archive.verify_deleted_branch(retired)
            self.assertEqual(packed.read_bytes(), content)
        packed.write_bytes(b'# pack-refs with: peeled \n' + head + b' refs/custom/fixture\n'
                           + head + ' refs/notes/caf\u00e9\n'.encode('utf-8')
                           + head + b' refs/tags/fixture\n^' + head + b'\n')
        result = subprocess.run([sys.executable, str(Path(archive.__file__))],
                                input=json.dumps({**retired, 'command': 'verify-deleted-branch'}) + '\n',
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(json.loads(result.stdout)['branchAbsent'])
        if prior_packed is None:
            packed.unlink()
        else:
            packed.write_bytes(prior_packed)
        real_identity = archive.identity
        def changed_common(path):
            value = real_identity(path)
            return {**value, 'ino': value['ino'] + 1} if path == common else value
        with patch.object(archive, 'identity', changed_common):
            with self.assertRaisesRegex(RuntimeError, 'common-store-incarnation-changed'):
                archive.verify_deleted_branch(retired)
        real_git, replaced = archive.git, [False]
        def replace_after_read(*args, **kwargs):
            result = real_git(*args, **kwargs)
            replaced[0] = True
            return result
        def raced_identity(path):
            return changed_common(path) if replaced[0] else real_identity(path)
        with patch.object(archive, 'git', replace_after_read), patch.object(archive, 'identity', raced_identity):
            with self.assertRaisesRegex(RuntimeError, 'common-store-incarnation-changed'):
                archive.verify_deleted_branch(retired)
        (self.txn / 'quarantine/working/base.txt').write_text('changed after deletion\n')
        with self.assertRaisesRegex(RuntimeError, 'metadata-recovery-source-content-or-identity-changed'):
            archive.verify_retired_quarantine(retired)

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
