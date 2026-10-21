"""Fixed native-policy inspection/review/draft helper. Never invokes a solver."""
from __future__ import annotations
import base64
import copy
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import stat
import subprocess
import sys
import tempfile
import time

TIERS = ("critical", "high", "normal", "low")
MAX_WEIGHT = 9_007_199_254_740_991
MAX_SOURCE = 1024 * 1024
MAX_CNL = 1024 * 1024
ID = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def sha(data): return hashlib.sha256(data).hexdigest()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
def pins(review):
    return {key: review[key] for key in ("policy", "workingDirectory", "sourceSha256", "inputs", "compilerSha256", "candidateSha256", "candidateCnlSha256", "changes")}


def checked_path(root, value, directory=False):
    if not isinstance(value, str) or len(value) > 1024 or "\\" in value or any(ord(c) < 32 for c in value): raise ValueError("Invalid workspace path")
    parts = value.split("/")
    if not parts or parts[0] != "workspace" or any(p in ("", ".", "..") for p in parts): raise ValueError("Use a workspace-relative path")
    path = root
    for part in parts:
        path = path / part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode): raise ValueError("Symbolic links are not supported")
    if directory and not path.is_dir(): raise ValueError("Working directory is unavailable")
    return path


def read_file(path, maximum=MAX_SOURCE):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise ValueError("A regular file is required")
        raw = stream.read(maximum + 1)
    if len(raw) > maximum: raise ValueError("Policy input exceeds the finite review limit")
    return raw


def changes_checked(ir, changes):
    rules = {row["id"]: row for row in ir["rules"]}
    if len(rules) != len(ir["rules"]) or not isinstance(changes, list) or not 1 <= len(changes) <= 200:
        raise ValueError("A bounded unique rule selection is required")
    result = []; seen = set()
    for row in changes:
        if not isinstance(row, dict) or set(row) != {"id", "weight", "priority"}: raise ValueError("Invalid soft-rule change")
        name = row["id"]; weight = row["weight"]
        if not isinstance(name, str) or name in seen or name not in rules: raise ValueError("Unknown or repeated rule")
        seen.add(name); original = rules[name]
        if original["tier"] != "soft": raise ValueError("Hard rules are locked; use the infeasibility review workflow")
        if not isinstance(weight, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", weight) or int(weight) > MAX_WEIGHT:
            raise ValueError("Weight must be an exact positive safe integer")
        if row["priority"] not in TIERS: raise ValueError("Unknown priority tier")
        if int(weight) == original["weight"] and row["priority"] == original.get("priority", "normal"): continue
        result.append({"id": name, "weight": weight, "priority": row["priority"]})
    if not result: raise ValueError("No soft-rule change was selected")
    return sorted(result, key=lambda row: row["id"])


def edit_source(source, ir, changes):
    lines = source.decode("utf8").splitlines(keepends=True)
    for change in changes:
        rule = next(row for row in ir["rules"] if row["id"] == change["id"])
        if not ID.fullmatch(rule["id"]) or type(rule["source_line"]) is not int: raise ValueError("Unsupported source rule identity")
        index = rule["source_line"] - 1
        if not 0 <= index < len(lines): raise ValueError("Invalid compiler source location")
        match = re.fullmatch(r"([ \t]*soft[ \t]+" + re.escape(rule["id"]) + r")([ \t]+[^:\r\n]*)(:[ \t]*(?:#[^\r\n]*)?)(\r?\n)?", lines[index])
        if not match: raise ValueError("This header form requires agent-assisted review")
        metadata = match[2]; fields = {}; end = 0; patches = []
        for token in re.finditer(r"(weight|priority|aggregation)[ \t]*(?:=[ \t]*)?([A-Za-z_][A-Za-z0-9_]*|[0-9]+)", metadata):
            if metadata[end:token.start()].strip() or token[1] in fields: raise ValueError("Ambiguous rule metadata")
            fields[token[1]] = token[2]; end = token.end()
            if token[1] in ("weight", "priority"): patches.append((token.start(2), token.end(2), change[token[1]]))
        if metadata[end:].strip() or fields.get("weight") != str(rule["weight"]) or fields.get("priority", "normal") != rule.get("priority", "normal"):
            raise ValueError("Compiler/header metadata mismatch")
        for start, end, value in reversed(patches): metadata = metadata[:start] + value + metadata[end:]
        if "priority" not in fields: metadata += " priority=" + change["priority"]
        lines[index] = match[1] + metadata + match[3] + (match[4] or "")
    return "".join(lines).encode("utf8")


def compare_ir(before, after, changes):
    expected = copy.deepcopy(before)
    for change in changes:
        row = next(rule for rule in expected["rules"] if rule["id"] == change["id"])
        row.update(weight=int(change["weight"]), weight_exact={"decimal": change["weight"]}, priority=change["priority"])
    if expected != after: raise ValueError("The revision changes more than the selected soft metadata")


def readable_rules(cnl, ir):
    """Read the pinned compiler's CNL format, never infer semantics from identifiers."""
    result = {}
    for block in re.finditer(r"^  rule\s+([A-Za-z_][A-Za-z0-9_]*)\s+\([^)]*\):\n(.*?)(?=^  rule(?:\s|$)|^\S|\Z)", cnl, re.M | re.S):
        summary = " ".join(block[2].partition("    policy:")[2].partition("\n    logic:")[0].split())
        if summary and not summary.startswith("not summarized;"):
            text = summary
        else:
            logic = block[2].partition("    logic:\n")[2]
            text = " ".join(line.strip() for line in logic.splitlines() if line.strip())
        if not text or block[1] in result: raise ValueError("Unsupported controlled-language rule format")
        result[block[1]] = text[:1200] + ("..." if len(text) > 1200 else "")
    if set(result) != {rule["id"] for rule in ir["rules"]}: raise ValueError("Incomplete controlled-language rule inventory")
    return result


def business_groups(file, source_sha, ir):
    if not file.exists() and not file.is_symlink(): return [], "not_supplied"
    value = json.loads(read_file(file))
    if not isinstance(value, dict) or set(value) != {"schema", "sourceSha256", "groups"} or value["schema"] != "rost/rule-presentation/v1":
        raise ValueError("Invalid business-rule catalogue")
    if value["sourceSha256"] != source_sha: return [], "stale"
    groups = value["groups"]; seen = set(); identities = set()
    if not isinstance(groups, list) or not 1 <= len(groups) <= 200: raise ValueError("Invalid business groups")
    for group in groups:
        if not isinstance(group, dict) or set(group) != {"id", "label", "description", "ruleIds"}: raise ValueError("Invalid business group")
        if not isinstance(group["id"], str) or not ID.fullmatch(group["id"]) or group["id"] in identities: raise ValueError("Invalid business group identity")
        identities.add(group["id"])
        for key, maximum in (("label", 200), ("description", 1200)):
            if not isinstance(group[key], str) or not 1 <= len(group[key]) <= maximum or "\0" in group[key]: raise ValueError("Invalid business description")
        if not isinstance(group["ruleIds"], list) or not 1 <= len(group["ruleIds"]) <= 2000: raise ValueError("Invalid group membership")
        for name in group["ruleIds"]:
            if not isinstance(name, str) or name in seen: raise ValueError("Repeated business-group rule")
            seen.add(name)
    if seen != {r["id"] for r in ir["rules"]}: raise ValueError("Business groups must cover every rule exactly once")
    return groups, "current"


class Workbench:
    def __init__(self, root=Path("/home/rakazo"), rost="/opt/rost/bin/rost"):
        self.root = Path(root).resolve(strict=True); self.rost = str(Path(rost).resolve(strict=True))
        self.deadline = time.monotonic() + 90
        self.version = sha(read_file(Path(self.rost), 64 * 1024**2))
    def command(self, args, cwd, maximum=16 * 1024**2):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0: raise ValueError("Policy review time allowance exhausted")
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            def finite_output(): resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024**2, 32 * 1024**2))
            process = subprocess.Popen([self.rost, *args], cwd=cwd, stdout=output, stderr=errors,
                                       start_new_session=True, preexec_fn=finite_output)
            try:
                process.wait(timeout=min(30, remaining)); output.seek(0); raw = output.read(maximum + 1)
                if process.returncode or len(raw) > maximum: raise ValueError("Rost check/CNL failed; inspect the policy diagnostics")
                return raw
            finally:
                if process.poll() is None:
                    import signal
                    os.killpg(process.pid, signal.SIGKILL); process.wait()
    def inputs(self, ir, cwd, policy=None):
        if ir.get("expert_extensions") or ir.get("unresolved_domain_modules") or any(key in ir for key in ("model_instances", "domain_operations", "extension_manifest")):
            raise ValueError("Expert/composed policies require their separate review workflow")
        refs = [row["path"] for row in ir.get("imports", [])]
        staff = ir.get("staff_source")
        if isinstance(staff, dict) and "path" in staff: refs.append(staff["path"])
        if len(refs) > 64: raise ValueError("Too many external inputs for this panel")
        result = []; total = 0
        for value in sorted(set(refs)):
            if not isinstance(value, str) or Path(value).is_absolute(): raise ValueError("Use audited workspace-relative inputs")
            rel = str(PurePosixPath(cwd.relative_to(self.root).as_posix()) / value)
            path = checked_path(self.root, rel); raw = read_file(path, 16 * 1024**2); total += len(raw)
            if total > 64 * 1024**2: raise ValueError("External input review cap reached")
            result.append({"path": path.relative_to(self.root).as_posix(), "sha256": sha(raw)})
        if policy is not None:
            catalogue = policy.with_suffix(".rules.json")
            if catalogue.exists() or catalogue.is_symlink():
                checked_path(self.root, catalogue.relative_to(self.root).as_posix())
                result.append({"path": catalogue.relative_to(self.root).as_posix(), "sha256": sha(read_file(catalogue)), "kind": "rule_presentation"})
        return result
    def inspect(self, policy, working_directory):
        path = checked_path(self.root, policy); cwd = checked_path(self.root, working_directory, True)
        if path.suffix != ".rost": raise ValueError("Choose a .rost source")
        ledger = path.with_suffix(".rost-relax.json")
        if ledger.exists() or ledger.is_symlink(): raise ValueError("A relaxation ledger requires its separate reviewed workflow")
        raw = read_file(path); raw.decode("utf8")
        ir = json.loads(self.command(["emit", str(path), "--format", "ir"], cwd))
        if not isinstance(ir.get("rules"), list) or len(ir["rules"]) > 2000: raise ValueError("Unsupported rule inventory")
        pins = self.inputs(ir, cwd, path)
        self.command(["check", str(path), "--json"], cwd)
        cnl = self.command(["cnl", str(path), "--output", "-"], cwd, MAX_CNL).decode("utf8")
        summaries = readable_rules(cnl, ir)
        groups, group_status = business_groups(path.with_suffix(".rules.json"), sha(raw), ir)
        group_ids = {name: group["id"] for group in groups for name in group["ruleIds"]}
        if read_file(path) != raw or self.inputs(ir, cwd, path) != pins: raise ValueError("Source or inputs changed during inspection")
        rows = [{"id": r["id"], "tier": r["tier"], "weight": str(r["weight"]) if r["weight"] is not None else None,
                 "summary": summaries[r["id"]], "groupId": group_ids.get(r["id"]),
                 "priority": r.get("priority", "normal"), "sourceLine": r["source_line"], "locked": r["tier"] != "soft"} for r in ir["rules"]]
        return {"policy": policy, "workingDirectory": working_directory, "sourceSha256": sha(raw), "inputs": pins,
                "compilerSha256": self.version, "cnl": cnl, "rules": rows, "groups": groups, "presentationStatus": group_status,
                "tiers": TIERS, "maxWeight": str(MAX_WEIGHT)}, ir, raw
    def review(self, policy, cwd, source_sha, changes):
        before, ir, source = self.inspect(policy, cwd)
        if before["sourceSha256"] != source_sha: raise ValueError("Source changed; load a fresh review")
        changes = changes_checked(ir, changes); candidate = edit_source(source, ir, changes)
        path = checked_path(self.root, policy); work = checked_path(self.root, cwd, True)
        with tempfile.TemporaryDirectory(prefix=".rost-priority-review-", dir=path.parent) as directory:
            preview = Path(directory) / "preview.rost"; preview.write_bytes(candidate)
            revised_ir = json.loads(self.command(["emit", str(preview), "--format", "ir"], work))
            compare_ir(ir, revised_ir, changes)
            self.command(["check", str(preview), "--json"], work)
            cnl_path = Path(directory) / "preview.cnl"
            self.command(["cnl", str(preview), "--output", str(cnl_path)], work)
            self.command(["cnl", str(preview), "--output", str(cnl_path), "--verify"], work)
            cnl = read_file(cnl_path, MAX_CNL).decode("utf8")
        if read_file(path) != source or self.inputs(ir, work, path) != before["inputs"]: raise ValueError("Source or inputs changed during review")
        return {"policy": policy, "workingDirectory": cwd, "sourceSha256": source_sha, "inputs": before["inputs"],
                "compilerSha256": self.version, "candidateSha256": sha(candidate), "candidateCnlSha256": sha(cnl.encode()),
                "changes": changes, "beforeRules": [r for r in before["rules"] if r["id"] in {c["id"] for c in changes}],
                "beforeCnl": before["cnl"], "afterCnl": cnl,
                "sourceDiff": "".join(difflib.unified_diff(source.decode().splitlines(True), candidate.decode().splitlines(True), fromfile=policy, tofile="new draft revision")),
                "policyApprovalGranted": False, "solveStarted": False}
    def apply(self, review, identity):
        if not re.fullmatch(r"[a-f0-9-]{36}", identity): raise ValueError("Invalid review identity")
        fresh = self.review(review["policy"], review["workingDirectory"], review["sourceSha256"], review["changes"])
        if pins(fresh) != pins(review): raise ValueError("Review changed; reload before selecting a revision")
        path = checked_path(self.root, review["policy"]); cwd = checked_path(self.root, review["workingDirectory"], True)
        source = read_file(path); ir = json.loads(self.command(["emit", str(path), "--format", "ir"], cwd))
        candidate = edit_source(source, ir, review["changes"])
        if sha(source) != review["sourceSha256"] or sha(candidate) != review["candidateSha256"] or self.inputs(ir, cwd, path) != review["inputs"]:
            raise ValueError("Candidate or input drift")
        output = path.with_name(path.stem + ".priorities-" + identity + ".rost")
        cnl_path = output.with_suffix(".cnl"); manifest = Path(str(cnl_path) + ".manifest.json")
        # Only new sibling drafts are published. The original and all active solve inputs remain untouched.
        exists = [target.exists() or target.is_symlink() for target in (output, cnl_path, manifest)]
        if any(exists):
            if not all(exists) or any(target.is_symlink() for target in (output, cnl_path, manifest)) or read_file(output) != candidate:
                raise ValueError("Incomplete or different revision exists; inspect before retrying")
        else:
            fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as stream: stream.write(candidate); stream.flush(); os.fsync(stream.fileno())
            self.command(["cnl", str(output), "--output", str(cnl_path)], cwd)
        self.command(["cnl", str(output), "--output", str(cnl_path), "--verify"], cwd)
        if sha(read_file(cnl_path, MAX_CNL)) != review["candidateCnlSha256"] or read_file(output) != candidate:
            raise ValueError("Saved revision does not match the review")
        if read_file(path) != source or self.inputs(ir, cwd, path) != review["inputs"]: raise ValueError("Baseline or inputs changed during publication")
        return {"policyPath": output.relative_to(self.root).as_posix(), "cnlPath": cnl_path.relative_to(self.root).as_posix(),
                "manifestPath": manifest.relative_to(self.root).as_posix(), "sourceSha256": sha(candidate),
                "cnlSha256": review["candidateCnlSha256"], "policyApprovalGranted": False, "solveStarted": False}


def main():
    raw = base64.b64decode(sys.argv[1], validate=True)
    if len(raw) > 2 * 1024**2: raise ValueError("Review request cap reached")
    request = json.loads(raw); work = Workbench()
    if request["operation"] == "inspect": result = work.inspect(request["policy"], request["workingDirectory"])[0]
    elif request["operation"] == "review": result = work.review(request["policy"], request["workingDirectory"], request["sourceSha256"], request["changes"])
    elif request["operation"] == "apply": result = work.apply(request["review"], request["id"])
    else: raise ValueError("Unsupported priority operation")
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(json.dumps({"error": str(error) if isinstance(error, ValueError) else "Policy review failed; inspect private diagnostics"}))
        sys.exit(1)
