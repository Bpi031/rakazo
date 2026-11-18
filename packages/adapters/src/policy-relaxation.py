"""Host-only native relaxation review/application. No roster solve or approval UI."""
import base64
import hashlib
import json
import math
import os
import signal
import subprocess
from pathlib import Path
import re
import sys
import tempfile
import time


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def make_decision(raw, review_sha, receipt):
    review = json.loads(base64.b64decode(raw, validate=True))
    if digest(review) != review_sha:
        raise ValueError('Native canonical review digest mismatch')
    if receipt['decision'] != 'approve' or receipt['subject'] == receipt['author']:
        raise ValueError('Independent manager approval required')
    approval = {'schema': 'rost/relaxation-approval/v1', 'provider': 'rakazo-manager-session',
        'subject': receipt['subject'], 'receipt_id': receipt['id'],
        'approved_at': receipt['decidedAt'], 'review_sha256': review_sha}
    identity = {'schema': 'rost/relaxation-decision/v1', 'review_sha256': review_sha,
                'approval': approval, 'authority_granted': True}
    return {**identity, 'review': review, 'decision_id': 'decision_' + digest(identity)[:24]}


def apply_sealed(work, source, encoded, cwd):
    """Older deployed Rost lacks the hash-pin flag; Linux seals pin the actual bytes."""
    import fcntl
    import resource
    fd = os.memfd_create('rost-owner-decision', os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
    try:
        with os.fdopen(os.dup(fd), 'wb') as file:
            file.write(encoded)
        os.lseek(fd, 0, os.SEEK_SET)
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
        if fcntl.fcntl(fd, fcntl.F_GET_SEALS) & seals != seals:
            raise ValueError('Immutable decision transport unavailable')
        with tempfile.TemporaryFile() as log:
            def limits():
                resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024**2, 4 * 1024**2))
            process = subprocess.Popen([work.rost, 'relax', 'apply', '/proc/self/fd/' + str(fd), '--file', str(source)],
                cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, pass_fds=(fd,),
                start_new_session=True, preexec_fn=limits)
            try:
                process.wait(timeout=max(1, work.deadline - time.monotonic()))
                if process.returncode:
                    raise ValueError('Native exact-decision application rejected')
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
    finally:
        os.close(fd)


def run(request, library):
    work = library['Workbench']()
    checked, read, sha = (library[k] for k in ('checked_path', 'read_file', 'sha'))
    cwd = checked(work.root, request['workingDirectory'], True)
    source = checked(work.root, request['policy'])
    if source.suffix != '.rost':
        raise ValueError('Native policy required')
    ledger = source.with_suffix('.rost-relax.json')
    operation = request['operation']
    if operation == 'capture_relaxation':
        seconds = request['seconds']
        if type(seconds) is not int or not 1 <= seconds <= 300:
            raise ValueError('Finite review reservation required')
        if time.time() + seconds + 240 >= request['deadlineUtc']:
            raise ValueError('Existing allowance expired')
        proposal = checked(work.root, request['proposal'])
        if proposal.suffix != '.rostrelax':
            raise ValueError('Restricted proposal required')
        raw = read(proposal)
        # Preflight the only two file-reference productions before the native parser.
        refs = {}
        for kind in ('policy', 'diagnosis'):
            matches = re.findall(r'^\s*' + kind + r'\s+("(?:[^"\\]|\\.)*")\s*$', raw.decode(), re.M)
            if len(matches) != 1:
                raise ValueError('One exact proposal file reference required')
            path = proposal.parent / json.loads(matches[0])
            relative = path.relative_to(work.root).as_posix()
            refs[kind] = checked(work.root, relative)
        if refs['policy'] != source or sha(read(refs['diagnosis'], 16 * 1024**2)) != request['diagnosisSha256']:
            raise ValueError('Proposal must use the exact diagnosed policy and evidence')
        before, _, _ = work.inspect(request['policy'], request['workingDirectory'])
        work.deadline = time.monotonic() + seconds + 30
        with tempfile.TemporaryDirectory(prefix='rost-relax-review-') as tmp:
            output, cnl = Path(tmp) / 'review.json', Path(tmp) / 'review.cnl'
            work.command(['relax', 'review', str(proposal), '--time-limit', str(seconds),
                          '--output', str(output), '--cnl-output', str(cnl)], cwd)
            review_raw = read(output, 2 * 1024**2)
            native = json.loads(review_raw)
            review_cnl = read(cnl).decode()
        if native['schema'] != 'rost/relaxation-review/v1' or native['authority_granted'] is not False:
            raise ValueError('Unsupported review')
        restoration = native['restoration']
        if (restoration['status'] != 'feasible_under_proposed_contract' or restoration['minimum_drift_proven'] is not True
                or restoration['assignments_present'] or restoration['deliverable_schedule_present']):
            raise ValueError('Restoration is not approval-ready')
        # Rust decodes these exact discrete values as f64; preserve its canonical .0 form.
        if any(type(value) not in (float, int) or not math.isfinite(value) or value != int(value)
               or not 0 <= value <= 9007199254740991 for value in restoration['actual_drift'].values()):
            raise ValueError('Only exact safe discrete drift is supported')
        native['restoration']['actual_drift'] = {key: float(value) for key, value in restoration['actual_drift'].items()}
        work.deadline = time.monotonic() + 90
        after, _, _ = work.inspect(request['policy'], request['workingDirectory'])
        if before != after or read(proposal) != raw:
            raise ValueError('Inputs changed during review')
        return {'nativeReviewRaw': base64.b64encode(canonical(native)).decode(), 'nativeReviewSha256': digest(native),
            'proposalSha256': sha(raw), 'nativePolicy': native['policy'], 'expiresAt': native['proposal']['expires_at'],
            'sourceDiff': 'No source text changed. Only the exact listed bounded exceptions would be applied.',
            'cnlDiff': review_cnl, 'candidate': {**before, 'cnl': review_cnl}, 'baseline': before}
    if operation not in ('check_relaxation', 'apply_relaxation'):
        raise ValueError('Unsupported protected operation')
    snapshot = request['snapshot']
    if ledger.exists() or ledger.is_symlink():
        raise ValueError('Existing ledger requires a fresh combined review; never overwrite it')
    live, _, _ = work.inspect(request['policy'], request['workingDirectory'])
    if live != snapshot['baseline'] or sha(read(checked(work.root, request['proposal']))) != snapshot['proposalSha256']:
        raise ValueError('Approved source, inputs, proposal or runtime changed')
    if operation == 'check_relaxation':
        return snapshot
    decision = make_decision(snapshot['nativeReviewRaw'], snapshot['nativeReviewSha256'], request['receipt'])
    encoded = canonical(decision)
    apply_sealed(work, source, encoded, cwd)
    return {'status': 'applied', 'policy': request['policy'], 'workingDirectory': request['workingDirectory'],
            'decisionId': decision['decision_id'], 'ledgerSha256': sha(read(ledger, 2 * 1024**2)),
            'solveStarted': False, 'backgroundLedgerSupported': False,
            'action': 'Exact approved exception applied. Use ledger-aware rost solve with a finite foreground allowance and an owned output directory, then validate. The installed rost job background runtime rejects ledgers: do not launch it, strip the ledger, or create a raw solver runner. A long background continuation requires runtime support, not more approval. No new compute granted.'}


if __name__ == '__main__':
    try:
        library = {'__name__': 'pinned_relaxation_library'}
        exec(compile(base64.b64decode(sys.argv[2], validate=True), '<pinned-library>', 'exec'), library)
        print(json.dumps(run(json.loads(base64.b64decode(sys.argv[1], validate=True)), library), allow_nan=False))
    except Exception:
        print(json.dumps({'error': 'Exact relaxation review/application could not be verified. Inspect the private evidence; no retry or roster solve.'}))
        sys.exit(1)
