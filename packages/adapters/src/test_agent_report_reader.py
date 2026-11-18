import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("report_reader", Path(__file__).with_name("agent-report-reader.py"))
READER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READER)


class ReportReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        os.chdir(self.temp.name)
        Path("workspace").mkdir()
        Path("workspace/source.json").write_text('{"assignments": []}')
        self.report = {"schema": "rakazo/agent-report/v1", "title": "Example", "sourcePaths": ["workspace/source.json"],
                       "sections": [{"kind": "text", "title": "Observation", "text": "Example"}]}
        self.save()

    def save(self):
        Path("workspace/report.json").write_text(json.dumps(self.report))

    def tearDown(self):
        os.chdir(self.previous)
        self.temp.cleanup()

    def test_hashes_actual_bytes_without_mutation(self):
        first = READER.read_report("workspace/report.json")
        self.assertEqual(first["sources"][0]["bytes"], 19)
        self.assertEqual(first, READER.read_report("workspace/report.json"))
        Path("workspace/source.json").write_text("[]")
        self.assertNotEqual(first["sources"], READER.read_report("workspace/report.json")["sources"])

    def test_parent_final_and_root_symlinks_are_rejected(self):
        Path("workspace/linked").symlink_to(Path("workspace/source.json").resolve())
        for path in ("workspace/../outside", "workspace/linked"):
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                READER.snapshot(path, 1000)
        Path("workspace/subdir").symlink_to(Path("workspace").resolve())
        with self.assertRaises(OSError):
            READER.snapshot("workspace/subdir/source.json", 1000)
        Path("workspace").rename("original")
        Path("workspace").symlink_to("original")
        with self.assertRaises(OSError):
            READER.read_report("workspace/report.json")

    def test_fifo_hardlink_directory_and_size_caps_fail(self):
        os.mkfifo("workspace/pipe")
        os.link("workspace/source.json", "workspace/hardlink")
        for path in ("workspace/pipe", "workspace/hardlink", "workspace"):
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                READER.snapshot(path, 1000)
        with self.assertRaises(ValueError):
            READER.snapshot("workspace/report.json", 2)

    def test_duplicate_nonfinite_missing_and_non_utf8_rejected(self):
        for value in ('{"sourcePaths":[],"sourcePaths":[]}', '{"value":NaN}', '{"sourcePaths":["workspace/missing"]}'):
            Path("workspace/report.json").write_text(value)
            with self.subTest(value=value), self.assertRaises((ValueError, OSError)):
                READER.read_report("workspace/report.json")
        Path("workspace/report.json").write_bytes(b"\xff")
        with self.assertRaises(UnicodeError):
            READER.read_report("workspace/report.json")

    def test_attachment_source_requires_unchanged_workspace_copy_not_wider_read_access(self):
        Path("attachments").mkdir()
        original = Path("attachments/upload.xlsx")
        original.write_bytes(b"synthetic workbook bytes")
        self.report["sourcePaths"] = ["attachments/upload.xlsx"]
        self.save()
        with self.assertRaises(READER.ReportSourceRejected) as caught:
            READER.read_report("workspace/report.json")
        self.assertEqual((caught.exception.code, caught.exception.index), ("ROST_REPORT_SOURCE_PATH", 0))
        Path("workspace/inputs").mkdir()
        copied = Path("workspace/inputs/upload.xlsx")
        copied.write_bytes(original.read_bytes())
        self.report["sourcePaths"] = [str(copied)]
        self.save()
        result = READER.read_report("workspace/report.json")
        self.assertEqual(result["sources"][0]["bytes"], original.stat().st_size)
        self.assertEqual(result["sources"][0]["sha256"], hashlib.sha256(original.read_bytes()).hexdigest())
        self.assertEqual(copied.read_bytes(), original.read_bytes())
        copied.unlink(); copied.symlink_to(original.resolve())
        with self.assertRaises(READER.ReportSourceRejected) as caught:
            READER.read_report("workspace/report.json")
        self.assertEqual(caught.exception.code, "ROST_REPORT_SOURCE_READ")


if __name__ == "__main__":
    unittest.main()
