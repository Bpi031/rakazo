"""Offline compiler-only regression: no license, optimization or client data."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("priorities", Path(__file__).with_name("policy-priority-helper.py"))
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
SOURCE = """#!rost v0.1
calendar:
    start = 2026-10-01
    end = 2026-10-02
shifts:
    shift D start=08:00 end=16:00
staff:
    person A tags worker
    person B tags worker
rules:
    # soft fairness weight=999 priority=critical:
    hard coverage:
        count({p in people where assigned(p, D, 2026-10-01)}) >= 1
    soft fairness weight=10 priority=normal:
        for p in people:
            count({d in days where assigned(p, D, d)}) <= 1
    soft balance weight=3:
        for p in people:
            count({d in days where assigned(p, D, d)}) >= 1
"""
IDENTITY = "e375d057-e532-4416-b617-3a6d2ab5a7c1"


class PureTests(unittest.TestCase):
    def test_path_escape_and_links(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); (root / "workspace").mkdir(); (root / "workspace/link").symlink_to(root)
            for value in ["/tmp/foo", "workspace/../foo", "workspace//foo", "workspace/./foo", "workspace\\foo", "workspace/link", "workspace/a\0"]:
                with self.subTest(value=value), self.assertRaises((ValueError, OSError)):
                    P.checked_path(root, value)

    def test_control_characters_are_rejected_even_when_the_named_file_exists(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); (root / "workspace").mkdir()
            for control in ("\n", "\t", "\x01", "\x1f"):
                value = "workspace/a" + control + "b"
                (root / value).write_text("not a policy")
                with self.subTest(control=repr(control)), self.assertRaises(ValueError):
                    P.checked_path(root, value)

    def test_ir_gate_forbids_other_semantic_changes(self):
        before = {"rules": [{"id": "s", "tier": "soft", "weight": 1, "weight_exact": {"decimal": "1"}, "priority": "normal", "body": [1]}]}
        change = [{"id": "s", "weight": "2", "priority": "low"}]
        after = copy.deepcopy(before); after["rules"][0].update(weight=2, weight_exact={"decimal": "2"}, priority="low")
        P.compare_ir(before, after, change)
        for key, value in [("tier", "hard"), ("body", [2])]:
            bad = copy.deepcopy(after); bad["rules"][0][key] = value
            with self.assertRaises(ValueError): P.compare_ir(before, bad, change)


@unittest.skipUnless(os.environ.get("ROST_PRIORITY_TEST_BIN") or Path("/opt/rost/bin/rost").exists(), "set ROST_PRIORITY_TEST_BIN for native compiler checks")
class CompilerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.work = self.root / "workspace/case"; self.work.mkdir(parents=True)
        self.policy = self.work / "policy.rost"; self.policy.write_text(SOURCE)
        self.bin = os.environ.get("ROST_PRIORITY_TEST_BIN", "/opt/rost/bin/rost")
        self.w = P.Workbench(self.root, self.bin)
        self.data, self.ir, _ = self.w.inspect("workspace/case/policy.rost", "workspace/case")
        self.change = [{"id": "fairness", "weight": "25", "priority": "high"}]

    def review(self):
        return self.w.review(self.data["policy"], self.data["workingDirectory"], self.data["sourceSha256"], self.change)

    def test_dynamic_inventory_has_real_locations_and_locked_hard_rule(self):
        self.assertEqual([r["id"] for r in self.data["rules"]], ["coverage", "fairness", "balance"])
        self.assertTrue(self.data["rules"][0]["locked"])
        self.assertFalse(list(self.work.glob("*.cnl*")))
        self.policy.write_text(SOURCE.replace("fairness", "updated_rule"))
        updated, _, _ = self.w.inspect(self.data["policy"], self.data["workingDirectory"])
        self.assertIn("updated_rule", [r["id"] for r in updated["rules"]])
        self.assertNotEqual(updated["sourceSha256"], self.data["sourceSha256"])

    def test_review_and_idempotent_draft_preserve_baseline_and_bodies(self):
        result = self.review(); self.assertIn("weight=25", result["sourceDiff"])
        self.assertNotEqual(result["beforeCnl"], result["afterCnl"])
        self.assertEqual(self.policy.read_text(), SOURCE)
        self.assertFalse(list(self.work.glob("*.priorities-*.rost")))
        saved = self.w.apply(P.pins(result), IDENTITY)
        self.assertFalse(saved["solveStarted"]); self.assertFalse(saved["policyApprovalGranted"])
        self.assertEqual(self.w.apply(P.pins(result), IDENTITY), saved)
        self.assertEqual(self.policy.read_text(), SOURCE)
        self.assertEqual(len(list(self.work.glob("*.priorities-*.rost"))), 1)

    def test_all_tiers_and_maximum_weight_keep_exact_ir(self):
        for tier in P.TIERS:
            with self.subTest(tier=tier):
                result = self.w.review(self.data["policy"], self.data["workingDirectory"], self.data["sourceSha256"],
                    [{"id": "balance", "weight": str(P.MAX_WEIGHT), "priority": tier}])
                self.assertIn(str(P.MAX_WEIGHT), result["afterCnl"])

    def test_reject_hard_unknown_duplicate_invalid_and_noop_changes(self):
        for changes in [[{**self.change[0], "id": "coverage"}], [{**self.change[0], "id": "missing"}], self.change * 2,
                        [{**self.change[0], "weight": "0"}], [{**self.change[0], "weight": str(P.MAX_WEIGHT + 1)}],
                        [{**self.change[0], "priority": "urgent"}], [{**self.change[0], "weight": "1.5"}],
                        [{**self.change[0], "weight": "10", "priority": "normal"}]]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                P.changes_checked(self.ir, changes)

    def test_source_drift_invalidates_review(self):
        result = self.review(); self.policy.write_text(SOURCE + "\n# agent changed source\n")
        with self.assertRaises(ValueError): self.w.apply(P.pins(result), IDENTITY)
        self.assertFalse(list(self.work.glob("*.priorities-*.rost")))

    def test_real_import_drift_invalidates_before_publication(self):
        (self.work / "data.json").write_text("{}")
        self.policy.write_text(SOURCE.replace("#!rost v0.1\n", '#!rost v0.1\nimport "data.json" as external\n'))
        data, _, _ = self.w.inspect(self.data["policy"], self.data["workingDirectory"])
        result = self.w.review(data["policy"], data["workingDirectory"], data["sourceSha256"], self.change)
        (self.work / "data.json").write_text('{"changed": true}')
        with self.assertRaises(ValueError): self.w.apply(P.pins(result), IDENTITY)
        self.assertFalse(list(self.work.glob("*.priorities-*.rost")))

    def test_business_size_cnl_exceeds_old_half_megabyte_limit(self):
        rules = "".join("    soft fairness_" + str(i) + "_" + "x" * 180 + " weight=10 priority=normal:\n"
                        "        for p in people:\n"
                        "            count({d in days where assigned(p, D, d)}) <= 1\n" for i in range(1500))
        self.policy.write_text(SOURCE.split("rules:\n")[0] + "rules:\n" + rules)
        data, _, _ = self.w.inspect(self.data["policy"], self.data["workingDirectory"])
        self.assertGreater(len(data["cnl"].encode()), 512 * 1024)
        self.assertEqual(len(data["rules"]), 1500)
        result = self.w.review(data["policy"], data["workingDirectory"], data["sourceSha256"],
            [{"id": data["rules"][0]["id"], "weight": "20", "priority": "high"}])
        self.assertNotEqual(result["beforeCnl"], result["afterCnl"])

    def test_existing_partial_output_and_tampered_pins_refused(self):
        result = self.review(); bad = P.pins(result); bad["candidateSha256"] = "0" * 64
        with self.assertRaises(ValueError): self.w.apply(bad, IDENTITY)
        (self.work / ("policy.priorities-" + IDENTITY + ".rost")).write_text("other work")
        with self.assertRaises(ValueError): self.w.apply(P.pins(result), IDENTITY)

    def test_relaxation_ledger_is_not_silently_dropped(self):
        self.policy.with_suffix(".rost-relax.json").write_text("{}")
        with self.assertRaises(ValueError): self.review()

    def test_existing_large_weight_is_preserved_for_priority_only_review(self):
        weight = "3915660135660"
        self.policy.write_text(SOURCE.replace("soft fairness weight=10", "soft fairness weight=" + weight))
        data, _, _ = self.w.inspect(self.data["policy"], self.data["workingDirectory"])
        result = self.w.review(data["policy"], data["workingDirectory"], data["sourceSha256"],
            [{"id": "fairness", "weight": weight, "priority": "high"}])
        self.assertEqual(result["changes"][0]["weight"], weight)
        self.assertIn("weight=" + weight + " priority=high", result["sourceDiff"])

    def test_crlf_and_header_comments_are_preserved(self):
        source = SOURCE.replace("priority=normal:", "priority=normal: # retained").replace("\n", "\r\n").encode()
        candidate = P.edit_source(source, self.ir, self.change)
        self.assertIn(b"priority=high: # retained\r\n", candidate)
        self.assertEqual(candidate.count(b"\r\n"), source.count(b"\r\n"))
        self.assertIn(b"# soft fairness weight=999 priority=critical:", candidate)

    def test_dependency_digest_and_extension_guard(self):
        file = self.work / "data.json"; file.write_text("[]")
        pins = self.w.inputs({"imports": [{"path": "data.json"}]}, self.work)
        file.write_text("[1]")
        self.assertNotEqual(pins, self.w.inputs({"imports": [{"path": "data.json"}]}, self.work))
        for ir in [{"expert_extensions": [1]}, {"domain_operations": []}]:
            with self.assertRaises(ValueError): self.w.inputs(ir, self.work)

    def test_commands_are_compiler_only(self):
        calls = []; original = self.w.command
        def command(args, *rest): calls.append(args); return original(args, *rest)
        with patch.object(self.w, "command", command): self.w.apply(P.pins(self.review()), IDENTITY)
        self.assertTrue(calls)
        self.assertTrue(all(args[0] in ("emit", "check", "cnl") for args in calls))
        self.assertTrue(all("mps" not in args for args in calls))

    def catalogue(self):
        return {"schema": "rost/rule-presentation/v1", "sourceSha256": self.data["sourceSha256"], "groups": [
            {"id": "coverage", "label": "Daily staffing", "description": "Minimum staffing; see each exact controlled-language rule.", "ruleIds": ["coverage"]},
            {"id": "fairness", "label": "Balanced duties", "description": "Individual workload preferences.", "ruleIds": ["fairness", "balance"]}]}

    def test_readable_cnl_and_lossless_business_groups(self):
        self.assertIn("count", self.data["rules"][0]["summary"])
        file = self.policy.with_suffix(".rules.json"); file.write_text(json.dumps(self.catalogue()))
        data, _, _ = self.w.inspect(self.data["policy"], self.data["workingDirectory"])
        self.assertEqual(data["presentationStatus"], "current")
        self.assertEqual(data["groups"][1]["label"], "Balanced duties")
        self.assertEqual(data["rules"][1]["groupId"], "fairness")
        self.assertEqual(data["inputs"][0]["kind"], "rule_presentation")
        result = self.w.review(data["policy"], data["workingDirectory"], data["sourceSha256"], self.change)
        changed = self.catalogue(); changed["groups"][0]["label"] = "Changed display text"; file.write_text(json.dumps(changed))
        with self.assertRaises(ValueError): self.w.apply(P.pins(result), IDENTITY)

    def test_business_groups_never_drop_rules_or_reuse_stale_labels(self):
        file = self.policy.with_suffix(".rules.json")
        for member in [[], ["missing"], ["coverage", "fairness"]]:
            value = self.catalogue(); value["groups"][0]["ruleIds"] = member; file.write_text(json.dumps(value))
            with self.assertRaises(ValueError): self.w.inspect(self.data["policy"], self.data["workingDirectory"])
        value = self.catalogue(); value["sourceSha256"] = "0" * 64; file.write_text(json.dumps(value))
        data, _, _ = self.w.inspect(self.data["policy"], self.data["workingDirectory"])
        self.assertEqual(data["presentationStatus"], "stale"); self.assertEqual(data["groups"], [])
        self.assertTrue(all(row["summary"] for row in data["rules"]))


if __name__ == "__main__": unittest.main()
