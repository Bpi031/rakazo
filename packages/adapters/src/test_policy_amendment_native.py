"""Opt-in installed-runtime smoke using only temporary synthetic policies."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


@unittest.skipUnless(os.environ.get('ROST_AMENDMENT_NATIVE_SMOKE') == '1', 'explicit installed runtime smoke only')
class NativeAmendment(unittest.TestCase):
    def test_person_amendments_and_two_background_reruns(self):
        library, helper, review, observer = [module(name) for name in
            ('policy-priority-helper', 'policy-amendment', 'policy-workflow', 'rost-job-observer')]
        rost = os.environ.get('ROST_BIN', '/opt/rost/bin/rost')
        # Retain bounded synthetic job evidence, including any unconfirmed cleanup.
        with contextlib.nullcontext(tempfile.mkdtemp(prefix='rost-amendment-synthetic-')) as tmp:
            root = Path(tmp)
            workspace = root / 'workspace'
            workspace.mkdir(mode=0o700)
            baseline = workspace / 'baseline.rost'
            original = '''#!rost v0.1
calendar:
    start = 2026-05-01
    end = 2026-05-04
shifts:
    shift day start=08:00 end=16:00
staff:
    person Scott tags blue
    person Alice tags blue
    person Bob
groups:
    group blue = {p in people where has_tag(p, "blue")}
leave:
    Scott off 2026-05-02 to 2026-05-04
rules:
    hard coverage:
        for each d in days:
            count({p in people where assigned(p, day, d)}) == 1
    hard leave_respected:
        for each p in people:
            for each d in days:
                if on_leave(p, d):
                    not assigned(p, day, d)
    hard quota:
        for each p in blue:
            count({d in days where assigned(p, day, d)}) == 2
'''
            baseline.write_text(original)
            def cli(args, check=True):
                result = subprocess.run([rost, *args], cwd=workspace, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=90)
                if check:
                    self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace')[-1600:])
                return result
            cli(['doctor', '--json'])
            cli(['diagnose', str(baseline), '--time-limit', '15', '--output', str(workspace / 'diagnosis.json')])
            self.assertEqual(json.loads((workspace / 'diagnosis.json').read_bytes())['control']['status'], 'infeasible')
            lib = vars(library).copy()
            lib['Workbench'] = lambda: library.Workbench(root=root, rost=rost)
            for action in ('exclude', 'quota'):
                candidate = workspace / (action + '.rost')
                body = '            count({d in days where assigned(p, day, d)}) == 2\n'
                revision = '            if p != Scott:\n    ' + body
                change = {'ruleId': 'quota', 'personId': 'Scott', 'action': action}
                if action == 'quota':
                    revision += '            if p == Scott:\n                count({d in days where assigned(p, day, d)}) == 1\n'
                    change['value'] = 1
                candidate.write_text(original.replace(body, revision))
                capture = {'operation': 'capture_amendment', 'baseline': 'workspace/baseline.rost',
                    'baselineWorkingDirectory': 'workspace', 'policy': 'workspace/' + candidate.name,
                    'workingDirectory': 'workspace', 'changes': [change]}
                snapshot = helper.run(capture, lib, review.run)
                self.assertTrue(snapshot['backgroundSupported'])
                self.assertFalse(snapshot['feasibilityEstablished'])
                self.assertFalse(candidate.with_suffix('.rost-relax.json').exists())
                # The TypeScript/PostgreSQL tests supply the independent owner receipt.
                # Here identical snapshots verify the reviewed bytes for both native starts.
                for attempt in (1, 2):
                    self.assertEqual(helper.run(capture, lib, review.run), snapshot)
                    out = workspace / f'{action}-run-{attempt}'
                    cli(['job', 'start', '--policy', str(candidate), '--out', str(out),
                         '--registry', str(workspace / 'registry'), '--backend', 'gurobi',
                         '--seconds', '60', '--max-seconds', '60', '--threads', '0', '--seed', '42', '--background'])
                    deadline = time.monotonic() + 120
                    status = None
                    while time.monotonic() < deadline:
                        status = json.loads(cli(['job', 'status', '--out', str(out)]).stdout)
                        if status['status'] in ('completed', 'stopped', 'failed'):
                            break
                        time.sleep(0.5)
                    else:
                        # Stop only this synthetic owned job, never a production handle.
                        cli(['job', 'control', '--out', str(out), '--action', 'stop', '--id', 'synthetic-timeout',
                             '--expected-revision', str(status['revision'])], check=False)
                        self.fail('Synthetic background run exceeded its deadline; inspect its owned evidence')
                    self.assertNotEqual(status['status'], 'failed', str(status.get('reason')))
                    self.assertIsNotNone(status.get('checked_candidate'), str(status))
                    self.assertEqual(observer.observe(out.name, workspace=workspace)['outcome'], 'candidate_needs_validation')
                    receipt = json.loads((out / 'result.json').read_bytes())['checked_candidate']
                    solution = receipt['solution']
                    self.assertTrue(Path(solution).resolve().is_relative_to(out.resolve()))
                    self.assertEqual(library.sha(Path(solution).read_bytes()), status['checked_candidate']['solution_sha256'])
                    cli(['validate', str(candidate), '--solution', solution])
                    intent = json.loads((out / 'intent.json').read_bytes())
                    self.assertEqual(intent['policy_sha256'], snapshot['candidate']['sourceSha256'])
                    self.assertEqual(intent['max_seconds'], 60)
                    self.assertEqual(helper.run(capture, lib, review.run), snapshot)
                    print(f'{action} background attempt {attempt}: checked candidate, validated, same reviewed revision', flush=True)
                self.assertEqual(baseline.read_text(), original)
                before = candidate.read_bytes()
                candidate.write_text(candidate.read_text().replace('== 1\n', '== 0\n', 1))
                with self.assertRaises(ValueError): helper.run(capture, lib, review.run)
                candidate.write_bytes(before)


if __name__ == '__main__': unittest.main()
