import base64
import importlib.util
import hashlib
from pathlib import Path
import tempfile
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observer = load('rost-job-observer')
relaxation = load('policy-relaxation')


class ClassifierTests(unittest.TestCase):
    def test_live_input_pins_refuse_drift_symlinks_and_outside_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'policy.rost'
            path.write_bytes(b'original')
            intent = {'policy': str(path), 'inputs': [{'path': str(path), 'sha256': hashlib.sha256(b'original').hexdigest()}]}
            observer.verify_current_inputs(intent, root)
            path.write_bytes(b'changed')
            with self.assertRaises(ValueError): observer.verify_current_inputs(intent, root)
            path.unlink(); path.symlink_to(root / 'elsewhere')
            with self.assertRaises(ValueError): observer.verify_current_inputs(intent, root)
            with self.assertRaises(ValueError): observer.verify_current_inputs({'policy':str(path), 'inputs':[{'path':'/outside','sha256':'0'*64}]}, root)

    def test_exact_native_proof(self):
        value = {'status': 'completed', 'native_terminal': {'status': 'native_returned',
            'native_status': 3, 'stage': 0, 'solution_count': 0}}
        self.assertEqual(observer.outcome(value), 'proven_infeasible')
        for key, wrong in [('native_status', 9), ('native_status', '3'), ('native_status', True),
                           ('stage', 1), ('stage', False), ('reason', 'priority_lock_numerical')]:
            changed = {**value, 'native_terminal': {**value['native_terminal'], key: wrong}}
            self.assertNotEqual(observer.outcome(changed), 'proven_infeasible')
        self.assertEqual(observer.outcome({**value, 'checked_candidate': {'solution': 'a.json'}}), 'candidate_needs_validation')
        self.assertEqual(observer.outcome({**value, 'status': 'failed'}), 'technical_failure')
        self.assertEqual(observer.outcome({**value, 'observed_status': 'recovery_required'}), 'technical_failure')
        self.assertEqual(observer.outcome({**value, 'status': 'stopped'}), 'no_candidate_unknown')

    def test_missing_json_and_running_are_not_proofs(self):
        for value in ({}, {'status': 'completed'}, {'status': 'stopped'}, {'status': 'running'}):
            self.assertNotEqual(observer.outcome(value), 'proven_infeasible')

    def test_decision_pins_native_review_and_independent_session(self):
        review = {'schema': 'rost/relaxation-review/v1', 'restoration': {'actual_drift': {'quota': 1.0}}}
        raw = base64.b64encode(relaxation.canonical(review)).decode()
        sha = relaxation.digest(review)
        receipt = {'decision': 'approve', 'subject': 'manager', 'author': 'agent:b:r', 'id': 'session-receipt', 'decidedAt': '2026-11-13T00:00:00Z'}
        result = relaxation.make_decision(raw, sha, receipt)
        self.assertEqual(result['approval']['subject'], 'manager')
        self.assertEqual(result['review_sha256'], sha)
        self.assertEqual(result['decision_id'], 'decision_' + relaxation.digest({k: result[k] for k in ('schema', 'review_sha256', 'approval', 'authority_granted')})[:24])
        with self.assertRaises(ValueError):
            relaxation.make_decision(raw, '0' * 64, receipt)
        for patch in ({'decision': 'reject'}, {'subject': receipt['author']}):
            with self.assertRaises(ValueError):
                relaxation.make_decision(raw, sha, {**receipt, **patch})


if __name__ == '__main__':
    unittest.main()
