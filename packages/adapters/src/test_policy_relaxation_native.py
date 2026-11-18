"""Opt-in, finite synthetic test; never loads a production policy or approval."""
import datetime
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


@unittest.skipUnless(os.environ.get('ROST_CONFLICT_NATIVE_SMOKE') == '1', 'explicit installed runtime smoke only')
class NativeLoop(unittest.TestCase):
    def test_diagnose_review_exact_apply_solve_validate(self):
        library = module('policy-priority-helper')
        helper = module('policy-relaxation')
        rost = os.environ.get('ROST_BIN', '/opt/rost/bin/rost')
        with tempfile.TemporaryDirectory(prefix='rost-conflict-synthetic-') as tmp:
            root = Path(tmp)
            workspace = root / 'workspace'
            workspace.mkdir(mode=0o700)
            policy = workspace / 'policy.rost'
            policy.write_text('''#!rost v0.1
calendar:
    start = 2026-05-01
    end = 2026-05-07
shifts:
    shift day start=08:00 end=16:00
staff:
    person Alice tags nurse
    person Bob tags nurse
    person Carol tags nurse
groups:
    group nurses = {p in people where has_tag(p, "nurse")}
rules:
    hard quota_min:
        for each d in days:
            count({p in nurses where assigned(p, day, d)}) >= 2
    hard quota_max:
        for each d in days:
            count({p in nurses where assigned(p, day, d)}) <= 1
''')
            def cli(args):
                result = subprocess.run([rost, *args], cwd=workspace, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=90)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace')[-2000:])
            cli(['diagnose', str(policy), '--time-limit', '15', '--output', str(workspace / 'diagnosis.json')])
            evidence = json.loads((workspace / 'diagnosis.json').read_bytes())
            option = next(row for row in evidence['evidence']['repair_options'] if row['rules'] == ['quota_max'])
            expiry = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
            (workspace / 'proposal.rostrelax').write_text(f'''#!rostrelax v0.1
proposal synthetic_capacity:
    policy "policy.rost"
    diagnosis "diagnosis.json"
    choose option {option['option_id']}
    permit quota_max:
        excess at most 7
    expires "{expiry}"
    reason "Synthetic offline integration test only"
''')
            class ObservedWorkbench(library.Workbench):
                def command(self, args, cwd, maximum=16 * 1024**2):
                    result = subprocess.run([self.rost, *args], cwd=cwd, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, timeout=max(1, self.deadline-time.monotonic()))
                    if result.returncode or len(result.stdout) > maximum:
                        raise ValueError('Synthetic native command failed: ' + result.stderr.decode(errors='replace')[-2000:])
                    return result.stdout
            lib = vars(library).copy()
            lib['Workbench'] = lambda: ObservedWorkbench(root=root, rost=rost)
            capture = {'operation': 'capture_relaxation', 'policy': 'workspace/policy.rost',
                'workingDirectory': 'workspace', 'proposal': 'workspace/proposal.rostrelax',
                'seconds': 15, 'deadlineUtc': time.time() + 600,
                'diagnosisSha256': library.sha((workspace / 'diagnosis.json').read_bytes())}
            snapshot = helper.run(capture, lib)
            self.assertFalse(policy.with_suffix('.rost-relax.json').exists())
            self.assertEqual(helper.run({**capture, 'operation': 'check_relaxation', 'snapshot': snapshot}, lib), snapshot)
            receipt = {'decision': 'approve', 'subject': 'synthetic-offline-owner', 'author': 'synthetic-agent',
                'id': 'synthetic-only', 'decidedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            result = helper.run({**capture, 'operation': 'apply_relaxation', 'snapshot': snapshot, 'receipt': receipt}, lib)
            self.assertEqual(result['status'], 'applied')
            self.assertFalse(result['solveStarted'])
            cli(['check', str(policy)])
            cli(['cnl', str(policy), '--output', str(workspace / 'policy.cnl')])
            cli(['solve', str(policy), '--time-limit', '15', '--output', str(workspace / 'solution.json')])
            cli(['validate', str(policy), '--solution', str(workspace / 'solution.json')])
            with self.assertRaises(ValueError):
                helper.run({**capture, 'operation': 'apply_relaxation', 'snapshot': snapshot, 'receipt': receipt}, lib)


if __name__ == '__main__':
    unittest.main()
