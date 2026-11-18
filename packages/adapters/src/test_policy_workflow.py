import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


workflow = module('policy_workflow', 'policy-workflow.py')
base = module('priority_base', 'policy-priority-helper.py')


class PolicyWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'workspace').mkdir()
        for name, text in [('old.rost', 'hard original'), ('new.rost', 'hard corrected'), ('staff.json', '[]')]:
            (self.root / 'workspace' / name).write_text(text)
        owner = self

        class FakeWorkbench:
            root = owner.root
            version = 'a' * 64

            def inspect(self, policy, cwd):
                raw = base.read_file(base.checked_path(self.root, policy))
                return {'inputs': []}, {}, raw

            def inputs(self, *args):
                return []

            def command(self, args, cwd):
                owner.commands.append(args)
                output = Path(args[args.index('--output') + 1])
                if '--verify' not in args:
                    output.write_text('Reviewed ' + Path(args[1]).read_text())
                    dependency = self.root / 'workspace/staff.json'
                    manifest = {'schema': 'rost/cnl-integrity-manifest/v2-structured', 'translation_complete': True,
                        'source': {'sha256': base.sha(Path(args[1]).read_bytes())}, 'cnl': {'sha256': base.sha(output.read_bytes())}, 'dependencies': [
                        {'path': str(dependency), 'kind': 'staff', 'sha256': base.sha(dependency.read_bytes())}]}
                    Path(str(output) + '.manifest.json').write_text(json.dumps(manifest))
                return b''

        self.commands = []
        self.library = vars(base).copy()
        self.library['Workbench'] = FakeWorkbench
        self.request = {'operation': 'capture', 'baseline': 'workspace/old.rost', 'baselineWorkingDirectory': 'workspace',
                        'policy': 'workspace/new.rost', 'workingDirectory': 'workspace'}

    def test_review_captures_exact_source_cnl_and_dependency_hashes_without_solver(self):
        before = {p.name: p.read_bytes() for p in (self.root / 'workspace').iterdir()}
        result = workflow.run(self.request, self.library)
        self.assertIn('+hard corrected', result['sourceDiff'])
        self.assertEqual(result['candidate']['dependencies'][0]['sha256'], hashlib.sha256(b'[]').hexdigest())
        self.assertTrue(all(c[0] == 'cnl' for c in self.commands))
        self.assertEqual(before, {p.name: p.read_bytes() for p in (self.root / 'workspace').iterdir()})

    def test_forbids_same_file_and_outside_paths(self):
        with self.assertRaises(ValueError):
            workflow.run({**self.request, 'policy': 'workspace/old.rost'}, self.library)
        with self.assertRaises(ValueError):
            workflow.run({**self.request, 'policy': '../outside'}, self.library)

    def test_symlink_policy_is_not_reviewable(self):
        (self.root / 'workspace/link.rost').symlink_to(self.root / 'workspace/new.rost')
        with self.assertRaises(ValueError):
            workflow.run({**self.request, 'policy': 'workspace/link.rost'}, self.library)

    def test_diagnosis_requires_finite_explicit_allowance_before_process(self):
        for seconds in [0, -1, 301, 1.5, True, float('inf')]:
            with self.assertRaises(ValueError):
                workflow.run({'operation': 'diagnose', 'seconds': seconds}, self.library)
        self.assertEqual(self.commands, [])

    def test_unknown_incomplete_or_unbound_manifest_is_rejected(self):
        command = self.library['Workbench'].command
        for replacement in [{'schema': 'unknown'}, {'translation_complete': False}, {'source': {'sha256': '0' * 64}}]:
            def modified(work, args, cwd):
                result = command(work, args, cwd)
                file = Path(args[args.index('--output') + 1] + '.manifest.json')
                value = json.loads(file.read_text())
                file.write_text(json.dumps({**value, **replacement}))
                return result
            self.library['Workbench'].command = modified
            with self.assertRaises(ValueError):
                workflow.run(self.request, self.library)
        self.library['Workbench'].command = command


@unittest.skipUnless(os.environ.get('ROST_PRIORITY_TEST_BIN') or Path('/opt/rost/bin/rost').exists(), 'installed compiler required')
class InstalledCompilerTests(unittest.TestCase):
    def test_real_cnl_manifest_capture_without_solve(self):
        fixtures = module('priority_fixtures', 'test_policy_priority_helper.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            work = root / 'workspace'
            work.mkdir()
            (work / 'old.rost').write_text(fixtures.SOURCE)
            (work / 'new.rost').write_text(fixtures.SOURCE.replace('}) >= 1', '}) >= 2', 1))
            binary = os.environ.get('ROST_PRIORITY_TEST_BIN', '/opt/rost/bin/rost')
            library = vars(base).copy()
            library['Workbench'] = lambda: base.Workbench(root, binary)
            request = {'operation': 'capture', 'baseline': 'workspace/old.rost', 'baselineWorkingDirectory': 'workspace',
                       'policy': 'workspace/new.rost', 'workingDirectory': 'workspace'}
            before = {p.name: p.read_bytes() for p in work.iterdir()}
            first = workflow.run(request, library)
            self.assertEqual(first, workflow.run(request, library))
            self.assertIn('>= 2', first['sourceDiff'])
            self.assertNotEqual(first['candidate']['cnlSha256'], first['baseline']['cnlSha256'])
            self.assertEqual(before, {p.name: p.read_bytes() for p in work.iterdir()})


if __name__ == '__main__':
    unittest.main()
