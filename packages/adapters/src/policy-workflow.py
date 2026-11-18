"""Pinned source review and bounded diagnosis. Never approves, edits policy or solves."""
import base64
import difflib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


def run(request, library):
    work = library['Workbench']()
    checked = library['checked_path']
    read = library['read_file']
    sha = library['sha']

    def capture(policy, cwd):
        value, ir, raw = work.inspect(policy, cwd)
        source = checked(work.root, policy)
        directory = checked(work.root, cwd, True)
        with tempfile.TemporaryDirectory(prefix='rost-owner-review-') as tmp:
            cnl = Path(tmp) / 'policy.cnl'
            work.command(['cnl', str(source), '--output', str(cnl)], directory)
            work.command(['cnl', str(source), '--output', str(cnl), '--verify'], directory)
            manifest = json.loads(read(Path(str(cnl) + '.manifest.json'), 4 * 1024**2))
            text = read(cnl).decode('utf8')
            if (manifest.get('source', {}).get('sha256') != sha(raw) or
                    manifest.get('cnl', {}).get('sha256') != sha(text.encode())):
                raise ValueError('CNL manifest does not bind the captured source and review')
            if manifest.get('schema') == 'rost/cnl-integrity-manifest/v2-structured':
                if manifest.get('translation_complete') is not True:
                    raise ValueError('Complete deterministic CNL is required')
                assurance = 'structured_complete'
            elif (manifest.get('schema') == 'rost/cnl-integrity-manifest/v1' and
                    manifest.get('cnl', {}).get('kind') == 'canonical_cnl' and
                    'translation_complete' not in manifest):
                # Rost 0.1.7 verifies this older manifest but has no completeness bit.
                # Its full source and per-rule controlled logic remain in the review.
                assurance = 'legacy_artifact_integrity_only'
            else:
                raise ValueError('Unsupported CNL review manifest')
            dependencies = []
            for pin in manifest['dependencies']:
                path = Path(pin['path'])
                if not path.is_absolute():
                    path = directory / path
                relative = path.relative_to(work.root).as_posix()
                actual = checked(work.root, relative)
                data = read(actual, 16 * 1024**2)
                if sha(data) != pin['sha256']:
                    raise ValueError('Review dependency changed')
                dependencies.append({'path': relative, 'sha256': sha(data), 'kind': pin['kind']})
        if read(source) != raw or work.inputs(ir, directory, source) != value['inputs']:
            raise ValueError('Source or input drift during review')
        return {'policy': policy, 'workingDirectory': cwd, 'sourceSha256': sha(raw),
                'compilerSha256': work.version, 'inputs': value['inputs'],
                'dependencies': sorted(dependencies, key=lambda p: (p['path'], p['kind'])),
                'cnlSha256': sha(text.encode()), 'cnlAssurance': assurance, 'cnl': text, 'source': raw.decode('utf8')}

    operation = request['operation']
    if operation == 'capture':
        before = capture(request['baseline'], request['baselineWorkingDirectory'])
        after = capture(request['policy'], request['workingDirectory'])
        if before['policy'] == after['policy']:
            raise ValueError('Keep the baseline unchanged; prepare a separate candidate file')
        return {'baseline': before, 'candidate': after,
                'sourceDiff': ''.join(difflib.unified_diff(before['source'].splitlines(True),
                    after['source'].splitlines(True), fromfile=before['policy'], tofile=after['policy'])),
                'cnlDiff': ''.join(difflib.unified_diff(before['cnl'].splitlines(True),
                    after['cnl'].splitlines(True), fromfile='Baseline CNL', tofile='Candidate CNL'))}
    if operation == 'diagnose':
        seconds = request['seconds']
        if type(seconds) is not int or not 1 <= seconds <= 300:
            raise ValueError('An explicit diagnosis allowance of 1-300 seconds is required')
        before = capture(request['policy'], request['workingDirectory'])
        source = checked(work.root, request['policy'])
        cwd = checked(work.root, request['workingDirectory'], True)
        identity = request['id']
        import re
        if not re.fullmatch('[a-f0-9]{64}', identity):
            raise ValueError('Invalid diagnosis identity')
        parent = work.root / 'workspace' / 'rost-diagnoses'
        parent.mkdir(mode=0o700, exist_ok=True)
        checked(work.root, 'workspace/rost-diagnoses', True)
        output = parent / identity
        output.mkdir(mode=0o700, exist_ok=False)
        started = time.monotonic()
        with (output / 'console.log').open('xb') as log:
            import resource
            def limit_output():
                resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024**2, 32 * 1024**2))
            process = subprocess.Popen([work.rost, 'diagnose', str(source), '--solver', 'gurobi', '--time-limit', str(seconds),
                '--output', str(output / 'diagnosis.json')], cwd=cwd, stdout=log, stderr=log,
                start_new_session=True, preexec_fn=limit_output)
            try:
                process.wait(timeout=seconds + 20)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                return {'status': 'indeterminate', 'reason': 'diagnostic_deadline',
                        'evidenceDirectory': str(output.relative_to(work.root)), 'solveStarted': False}
        work.deadline = time.monotonic() + 90
        after = capture(request['policy'], request['workingDirectory'])
        if before != after:
            raise ValueError('Diagnosis inputs changed; evidence cannot describe the current policy')
        file = output / 'diagnosis.json'
        raw = read(file, 16 * 1024**2) if file.exists() else None
        evidence = json.loads(raw) if raw else {}
        control = evidence.get('control', {})
        return {'status': control.get('status', 'indeterminate'), 'exitCode': process.returncode,
                'evidencePath': str(file.relative_to(work.root)) if raw else None,
                'evidenceSha256': sha(raw) if raw else None, 'sourceSha256': before['sourceSha256'],
                'snapshot': before,
                'wallSeconds': time.monotonic() - started, 'solveStarted': False,
                'action': 'Read the saved diagnosis. Unknown/time limit is not infeasible. Diagnosis does not select or authorize a rule change. Empty repair options do not prove no repair exists. Formal relaxation ledgers still require exact external decisions; investigative or FeasRelax witnesses are never deliverable rosters.'}
    raise ValueError('Unsupported policy workflow operation')


if __name__ == '__main__':
    try:
        library = {'__name__': 'rost_review_library'}
        exec(compile(base64.b64decode(sys.argv[2], validate=True), 'pinned-review-library', 'exec'), library)
        result = run(json.loads(base64.b64decode(sys.argv[1], validate=True)), library)
        print(json.dumps(result, ensure_ascii=True, allow_nan=False))
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else 'Policy workflow failed; inspect private evidence. No retry was made.'}))
        sys.exit(1)
