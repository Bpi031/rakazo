import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('native_files_test',Path(__file__).with_name('native-files.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class NativeFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'workspace').mkdir()
        self.patch=patch.object(module,'HOME',self.root);self.patch.start();self.addCleanup(self.patch.stop)
        (self.root/'workspace/a.rost').write_text('reviewed source')
    def test_reads_and_receipts_preserve_exact_source(self):
        value=module.execute({'operation':'read','path':'workspace/a.rost'})
        self.assertEqual(value['text'],'reviewed source')
        self.assertEqual(module.execute({'operation':'receipt','paths':['workspace/a.rost']})['files'][0]['sha256'],value['sha256'])
        self.assertEqual(len(module.execute({'operation':'inventory'})['files']),1)
    def test_escape_secret_symlink_and_binary_text_denied(self):
        (self.root/'workspace/x.rost').symlink_to(self.root/'workspace/a.rost')
        for path in ['workspace/x.rost','workspace/../x.json','/etc/passwd','workspace/.env','workspace/gurobi.lic','workspace/credentials.json']:
            with self.subTest(path=path),self.assertRaises((OSError,ValueError)):module.inspect(path,True)
        (self.root/'workspace/file.xlsx').write_bytes(b'binary')
        with self.assertRaises(ValueError):module.inspect('workspace/file.xlsx',True)
    def test_malformed_oversized_files_and_mutations_are_denied(self):
        for content in [b'x'*64001,b'\xff',b'\x00']:
            (self.root/'workspace/a.rost').write_bytes(content)
            with self.assertRaises((ValueError,UnicodeError)):module.inspect('workspace/a.rost',True)
        for op in ['write','solve','apply']:
            with self.assertRaises(ValueError):module.execute({'operation':op})
