"""Read one private Rost job. No solving, control writes, licenses or model calls."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

JOB_STATUSES = frozenset(("reserved", "preparing", "starting", "running", "stopping", "checking",
                          "completed", "stopped", "failed", "recovery_required"))


def outcome(status):
    """Only a first-stage, native proof can diagnose the original hard model."""
    if status.get('observed_status') == 'recovery_required' or status.get('status') == 'recovery_required':
        return 'technical_failure'
    if status.get('status') not in ('completed', 'stopped', 'failed'):
        return 'running'
    if status.get('status') == 'failed':
        return 'technical_failure'
    terminal = status.get('native_terminal') or {}
    if status.get('checked_candidate'):
        return 'candidate_needs_validation'
    if (status.get('status') == 'completed' and terminal.get('status') == 'native_returned'
            and type(terminal.get('native_status')) is int and terminal['native_status'] == 3
            and type(terminal.get('stage')) is int and terminal['stage'] == 0
            and terminal.get('solution_count') == 0 and not terminal.get('reason')):
        return 'proven_infeasible'
    return 'no_candidate_unknown'


def verify_current_inputs(intent, root):
    ledger = Path(intent['policy']).with_suffix('.rost-relax.json')
    if ledger.exists() or ledger.is_symlink():
        raise ValueError('The effective policy changed after this job')
    if not isinstance(intent.get('inputs'), list) or not 1 <= len(intent['inputs']) <= 256:
        raise ValueError('Missing bounded input pins')
    total = 0
    for pin in intent['inputs']:
        path = Path(pin['path'])
        relative = path.relative_to(root)
        current = root
        for part in relative.parts:
            current = current / part
            if part in ('', '.', '..') or current.is_symlink():
                raise ValueError('Unstable input path')
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('Input must be regular')
            raw = stream.read(16 * 1024**2 + 1)
        total += len(raw)
        if len(raw) > 16 * 1024**2 or total > 64 * 1024**2 or hashlib.sha256(raw).hexdigest() != pin['sha256']:
            raise ValueError('Current inputs do not match the terminal proof')


def observe(relative, *, workspace=Path("/home/rakazo/workspace")):
    parts = relative.split("/")
    if (not relative or len(relative) > 512 or any(p in ("", ".", "..") for p in parts)
            or any(ord(c) < 32 for c in relative) or relative.startswith("/")):
        raise ValueError("invalid relative job path")
    root = workspace.resolve(strict=True)
    directory = root.joinpath(*parts).resolve(strict=True)
    if directory == root or not directory.is_relative_to(root) or not directory.is_dir():
        raise ValueError("outside private workspace")
    intent_path = directory / "intent.json"
    if intent_path.is_symlink() or intent_path.stat().st_size > 262144:
        raise ValueError("invalid intent")
    intent = json.loads(intent_path.read_bytes())
    if intent.get("schema") != "rost/solve-intent/v1":
        raise ValueError("unsupported intent")
    # Preparation can add captured inputs; bind only immutable reservation identity.
    identity = {key: intent[key] for key in (
        "schema", "created_utc", "created_monotonic", "policy_sha256", "rost_sha256",
        "maximum_deadline_utc", "max_seconds", "seconds", "threads", "seed")}
    if not isinstance(identity["maximum_deadline_utc"], (float, int)):
        raise ValueError("invalid deadline")
    binding = hashlib.sha256(json.dumps(identity, sort_keys=True, allow_nan=False).encode()).hexdigest()
    result = subprocess.run(
        ["/opt/rost/bin/rost", "job", "status", "--out", str(directory)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=10, check=True,
    )
    if len(result.stdout) > 65536:
        raise ValueError("status cap")
    status = json.loads(result.stdout)
    if status.get("schema") != "rost/solve-job/v1":
        raise ValueError("unsupported status")
    if not isinstance(status.get("status"), str) or status["status"] not in JOB_STATUSES:
        raise ValueError("unsupported job status")
    if "observed_status" in status and status["observed_status"] != "recovery_required":
        raise ValueError("unsupported observed status")
    classification = outcome(status)
    if classification == 'proven_infeasible':
        verify_current_inputs(intent, root)
    return {"binding": binding, "deadlineUtc": identity["maximum_deadline_utc"],
            "status": status.get("status"),
            "outcome": classification,
            **({"observedStatus": status["observed_status"]} if "observed_status" in status else {})}


if __name__ == "__main__":
    try:
        print(json.dumps(observe(sys.argv[1]), allow_nan=False))
    except Exception:
        # Never disclose paths, status contents or subprocess output on failure.
        print(json.dumps({"error": "owned_job_observation_unavailable"}))
        sys.exit(1)
