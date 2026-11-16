import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("observer", Path(__file__).with_name("rost-job-observer.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ObserverTests(unittest.TestCase):
    def test_team_observer_stays_within_the_selected_own_or_shared_root(self):
        for prefix in ('bots/a', 'shared'):
            root = self.root / prefix
            (root / 'job').mkdir(parents=True)
            (root / 'job/intent.json').write_bytes(self.path.read_bytes())
            (root / 'foreign').symlink_to(self.root / 'job', target_is_directory=True)
            with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0,
                    json.dumps({'schema': 'rost/solve-job/v1', 'status': 'running'}).encode())) as run:
                self.assertEqual(module.observe('job', workspace=root)['status'], 'running')
                self.assertEqual(run.call_args.args[0][-1], str(root / 'job'))
                with self.assertRaises(ValueError): module.observe('foreign', workspace=root)
                self.assertEqual(run.call_count, 1)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "job").mkdir()
        self.intent = {"schema": "rost/solve-intent/v1", "created_utc": 100, "created_monotonic": 100,
                       "policy_sha256": "a"*64, "rost_sha256": "b"*64, "maximum_deadline_utc": 21700,
                       "max_seconds": 21600, "seconds": 21600, "threads": 0, "seed": 42}
        self.path = self.root / "job/intent.json"
        self.path.write_text(json.dumps(self.intent))

    def observe(self, status=None):
        with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(
                status or {"schema": "rost/solve-job/v1", "status": "running"}).encode())) as run:
            result = module.observe("job", workspace=self.root)
        self.assertEqual(run.call_args.args[0], ["/opt/rost/bin/rost", "job", "status", "--out", str(self.root / "job")])
        self.assertEqual(run.call_args.kwargs["timeout"], 10)
        return result

    def test_observes_without_modifying_files_and_preserves_binding_during_preparation(self):
        before = self.path.read_bytes()
        first = self.observe()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertNotIn("observedStatus", first)
        self.intent["inputs"] = [{"path": "private", "sha256": "c"*64}]
        self.path.write_text(json.dumps(self.intent))
        self.assertEqual(self.observe()["binding"], first["binding"])
        self.intent["created_utc"] += 1
        self.path.write_text(json.dumps(self.intent))
        self.assertNotEqual(self.observe()["binding"], first["binding"])

    def test_path_escapes_and_symlinked_intent_never_execute_any_command(self):
        with patch.object(module.subprocess, "run") as run:
            for path in ["/tmp/job", "../job", "job/../job", "job//x", "job\0x", "", "."]:
                with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                    module.observe(path, workspace=self.root)
            self.path.unlink()
            self.path.symlink_to(self.root / "elsewhere")
            with self.assertRaises((ValueError, OSError)):
                module.observe("job", workspace=self.root)
            run.assert_not_called()

    def test_recovery_signal_and_invalid_status_or_oversize_fail_closed(self):
        result = self.observe({"schema": "rost/solve-job/v1", "status": "running", "observed_status": "recovery_required"})
        self.assertEqual(result["observedStatus"], "recovery_required")
        with self.assertRaises(ValueError):
            self.observe({"schema": "not-rost", "status": "completed"})
        with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"x"*65537)):
            with self.assertRaises(ValueError):
                module.observe("job", workspace=self.root)
