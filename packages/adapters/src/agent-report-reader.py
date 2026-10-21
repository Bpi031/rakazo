"""Read bounded report/source snapshots without following workspace symlinks."""
import base64
import hashlib
import json
import os
import stat
import sys

REPORT_CAP = 262144
SOURCE_CAP = 64 * 1024 * 1024


def workspace_path(value):
    if not isinstance(value, str) or len(value) > 1024 or not value.startswith("workspace/"):
        raise ValueError("Use a workspace-relative path")
    parts = value.split("/")
    if any(p in {"", ".", ".."} for p in parts) or "\\" in value or any(ord(c) < 32 for c in value):
        raise ValueError("Invalid workspace path")
    return parts


def snapshot(value, cap, content=False):
    parts = workspace_path(value)
    if len(parts) > 32:
        raise ValueError("Path depth exceeded")
    directory = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > cap or before.st_nlink != 1:
                raise ValueError("Source must be a bounded private regular file")
            digest = hashlib.sha256()
            chunks = []
            total = 0
            while True:
                chunk = os.read(fd, min(65536, cap + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > cap:
                    raise ValueError("Source exceeds finite cap")
                digest.update(chunk)
                if content:
                    chunks.append(chunk)
            after = os.fstat(fd)
            identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
            if identity(before) != identity(after) or total != before.st_size:
                raise ValueError("Source changed during read")
            return {"path": value, "sha256": digest.hexdigest(), "bytes": total}, b"".join(chunks)
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def read_report(report_path):
    receipt, data = snapshot(report_path, REPORT_CAP, True)
    report = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
    paths = report.get("sourcePaths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= 8 or len(set(paths)) != len(paths):
        raise ValueError("One to eight distinct sources required")
    sources = [snapshot(path, SOURCE_CAP)[0] for path in paths]
    # Detect replacement or modification between sequential source reads.
    for previous in sources:
        if snapshot(previous["path"], SOURCE_CAP)[0] != previous:
            raise ValueError("Sources changed during publication")
    if snapshot(report_path, REPORT_CAP)[0] != receipt:
        raise ValueError("Report changed during publication")
    return {"report": report, "reportSha256": receipt["sha256"], "sources": sources}


if __name__ == "__main__":
    try:
        path = base64.b64decode(sys.argv[1], validate=True).decode("utf-8")
        print(json.dumps(read_report(path), ensure_ascii=True, allow_nan=False))
    except Exception:
        print(json.dumps({"error": "Report/source read rejected; inspect paths, size, links and JSON locally"}))
        sys.exit(1)
