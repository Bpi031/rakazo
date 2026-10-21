import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('workbench_files_tested', Path(__file__).with_name('workbench-files.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class WorkbenchFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'workspace').mkdir()
        self.patch = patch.object(module, 'HOME', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        (self.root / 'workspace/policy.rost').write_text('original\n')
    def request(self, operation='capture', **kwargs):
        return module.execute({'operation': operation, 'path': 'workspace/policy.rost', **kwargs})
    def test_exact_new_draft_preserves_source_and_replays_only_identical_bytes(self):
        captured = self.request()
        args = {'id': 'a1afc5c5-78f2-4bb2-8530-a2d9d98bb411', 'sourceSha256': captured['sourceSha256'], 'proposedText': 'new draft\n'}
        saved = self.request('save', **args)
        self.assertEqual((self.root / 'workspace/policy.rost').read_text(), 'original\n')
        self.assertEqual((self.root / saved['draftPath']).read_text(), 'new draft\n')
        self.assertEqual(self.request('save', **args), saved)
        self.assertFalse(saved['policyApprovalGranted'])
        with self.assertRaises(ValueError): self.request('save', **{**args, 'proposedText': 'different'})
    def test_source_drift_fails_before_creating_any_draft(self):
        captured = self.request()
        (self.root / 'workspace/policy.rost').write_text('changed')
        with self.assertRaises(ValueError): self.request('save', id='a1afc5c5-78f2-4bb2-8530-a2d9d98bb411', sourceSha256=captured['sourceSha256'], proposedText='draft')
        self.assertEqual(len(list((self.root / 'workspace').iterdir())), 1)
    def test_rejects_frozen_paths_secrets_traversal_and_symlinks(self):
        for path in ['/etc/passwd', 'workspace/../x.rost', 'workspace/frozen/policy.rost', 'workspace/.env', 'workspace/gurobi.lic', 'workspace/no\x00pe.rost']:
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)): module.execute({'operation': 'capture', 'path': path})
        (self.root / 'workspace/link.rost').symlink_to(self.root / 'workspace/policy.rost')
        with self.assertRaises(OSError): module.execute({'operation': 'capture', 'path': 'workspace/link.rost'})
    def test_rejects_hardlinks_oversize_and_non_utf8(self):
        import os
        os.link(self.root / 'workspace/policy.rost', self.root / 'workspace/hard.rost')
        with self.assertRaises(ValueError): self.request()
        (self.root / 'workspace/hard.rost').unlink()
        for data in [b'x' * 64001, b'\xff', b'\x00']:
            (self.root / 'workspace/policy.rost').write_bytes(data)
            with self.assertRaises((ValueError, UnicodeError)): self.request()

if __name__ == '__main__': unittest.main()
