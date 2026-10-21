"""Operator-owned bounded file/skill bridge; never edits an existing source."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

HOME = Path('/home/rakazo')
EXTENSIONS = {'.rost', '.cnl', '.md', '.txt', '.json', '.csv', '.py'}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def source(path):
    parts = path.split('/')
    if (len(parts) < 2 or parts[0] != 'workspace' or len(path) > 500
            or any(not p or p in ('.', '..', 'frozen', 'inputs', 'checked', 'checkpoints') or p.startswith('.') or re.search(r'[\\\x00-\x1f]', p) for p in parts)
            or Path(parts[-1]).suffix.lower() not in EXTENSIONS):
        raise ValueError('Unapproved draft source')
    fd = os.open(HOME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(file)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 64000 or info.st_nlink != 1:
                raise ValueError('Bounded regular source required')
            data = os.read(file, 64001)
            if len(data) > 64000:
                raise ValueError('Source too large')
            text = data.decode('utf-8')
            if '\x00' in text:
                raise ValueError('Invalid source text')
            return fd, parts[-1], text, digest(data)
        finally:
            os.close(file)
    except BaseException:
        os.close(fd)
        raise

def catalogue():
    roots = [Path('/opt/team/office/skills')]
    if os.environ.get('TEAM_COMPUTER_ROLE') == 'manager':
        roots.append(Path('/opt/rost/skills'))
    result = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.glob('*/SKILL.md'))[:64]:
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(root.resolve()) or resolved.stat().st_uid != 0 or resolved.stat().st_mode & 0o022:
                continue
            data = resolved.read_bytes()
            if len(data) > 128000:
                continue
            text = data.decode('utf-8')
            description = next((line.strip() for line in text.splitlines() if line.startswith('description:')), '')
            sha = digest(data)
            result.append({'id': digest((str(resolved) + ':' + sha).encode()), 'name': path.parent.name,
                           'path': str(resolved), 'sha256': sha, 'description': description[12:].strip()[:300]})
    return {'skills': result[:64]}

def execute(value):
    if value['operation'] == 'skills':
        return catalogue()
    fd, leaf, before, sha = source(value['path'])
    try:
        if value['operation'] == 'capture':
            return {'path': value['path'], 'before': before, 'sourceSha256': sha}
        if value['operation'] != 'save' or sha != value['sourceSha256']:
            raise ValueError('Source changed; review again')
        if not re.fullmatch(r'[a-f0-9-]{36}', value['id']):
            raise ValueError('Exact draft id required')
        text = value['proposedText']
        data = text.encode('utf-8')
        if len(data) > 64000 or '\x00' in text:
            raise ValueError('Draft exceeds finite cap')
        stem, suffix = os.path.splitext(leaf)
        name = stem + '.review-' + value['id'] + suffix
        expected = digest(data)
        try:
            target = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        except FileExistsError:
            target = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                info = os.fstat(target)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or digest(os.read(target, 64001)) != expected:
                    raise ValueError('Existing draft is not the reviewed bytes')
            finally:
                os.close(target)
        else:
            with os.fdopen(target, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        os.fsync(fd)
        verify_fd, _, _, current = source(value['path'])
        os.close(verify_fd)
        if current != sha:
            raise ValueError('Source drifted; draft remains unselected')
        return {'draftPath': value['path'].rsplit('/', 1)[0] + '/' + name, 'draftSha256': expected,
                'originalUnchanged': True, 'policyApprovalGranted': False, 'solveStarted': False}
    finally:
        os.close(fd)

if __name__ == '__main__':
    try:
        raw = base64.b64decode(sys.argv[1], validate=True)
        if len(raw) > 200000:
            raise ValueError('Input too large')
        print(json.dumps(execute(json.loads(raw)), ensure_ascii=True))
    except Exception:
        print(json.dumps({'error': 'Workbench file operation rejected; inspect exact source, path and finite limits'}))
        sys.exit(1)
