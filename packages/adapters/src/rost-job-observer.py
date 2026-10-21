"""Read one private Rost job. No solving, control writes, licenses or model calls."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


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
    return {"binding": binding, "deadlineUtc": identity["maximum_deadline_utc"],
            "status": status.get("status"),
            **({"observedStatus": status["observed_status"]} if "observed_status" in status else {})}


if __name__ == "__main__":
    try:
        print(json.dumps(observe(sys.argv[1]), allow_nan=False))
    except Exception:
        # Never disclose paths, status contents or subprocess output on failure.
        print(json.dumps({"error": "owned_job_observation_unavailable"}))
        sys.exit(1)
