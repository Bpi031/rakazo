"""Bounded read-only private workspace observations. Never executes policy or solver."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

HOME = Path('/home/rakazo')
TEXT = {'.rost', '.cnl', '.py', '.md', '.txt', '.csv', '.json', '.yaml', '.toml'}
PUBLIC = TEXT | {'.xlsx', '.xlsm', '.xls', '.docx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.webp'}

def parts(path):
    p = path.split('/')
    if len(path) > 500 or len(p) < 2 or p[0] != 'workspace' or any(not s or s in ('.', '..') or s.startswith('.') or '\\' in s or any(ord(c) < 32 for c in s) for s in p):
        raise ValueError('Private workspace path required')
    if Path(p[-1]).suffix.lower() not in PUBLIC or any(x in p[-1].lower() for x in ('license', 'credential', 'secret', 'gurobi.lic', 'api_key')):
        raise ValueError('Unapproved observation')
    return p

def inspect(path, text=False):
    p = parts(path)
    fd = os.open(HOME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in p[:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        f = os.open(p[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(f)
            cap = 64000 if text else 128 * 1024**2
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > cap:
                raise ValueError('Finite regular file required')
            sha = hashlib.sha256(); chunks = []; size = 0
            while True:
                chunk = os.read(f, 65536)
                if not chunk: break
                size += len(chunk)
                if size > cap: raise ValueError('Read cap')
                sha.update(chunk)
                if text: chunks.append(chunk)
            after = os.fstat(f)
            if (before.st_ino, before.st_mtime_ns, before.st_size) != (after.st_ino, after.st_mtime_ns, after.st_size):
                raise ValueError('File changed while observing')
            result = {'path': path, 'sha256': sha.hexdigest(), 'bytes': size, 'modifiedAtMs': after.st_mtime_ns // 1000000}
            if text:
                if Path(path).suffix.lower() not in TEXT: raise ValueError('Text file required')
                content = b''.join(chunks).decode('utf-8')
                if '\x00' in content: raise ValueError('Invalid text')
                result['text'] = content
            return result
        finally: os.close(f)
    finally: os.close(fd)

def inventory():
    result = []; seen = 0
    def walk(fd, prefix, depth):
        nonlocal seen
        if depth > 24: raise ValueError('Directory depth cap')
        for name in sorted(os.listdir(fd)):
            seen += 1
            if seen > 10000 or len(result) >= 2000: return True
            if name.startswith('.'): continue
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if walk(child, prefix + '/' + name, depth + 1): return True
                finally: os.close(child)
                continue
            relative = prefix + '/' + name
            try: parts(relative)
            except ValueError: continue
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                result.append({'path': relative, 'bytes': info.st_size, 'modifiedAtMs': info.st_mtime_ns // 1000000})
        return False
    parent = os.open(HOME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: root = os.open('workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    finally: os.close(parent)
    try: truncated = walk(root, 'workspace', 0)
    finally: os.close(root)
    return {'files': result, 'truncated': truncated}

def execute(value):
    op = value['operation']
    if op == 'inventory': return inventory()
    if op == 'read': return inspect(value['path'], text=True)
    if op == 'receipt':
        paths = value['paths']
        if not isinstance(paths, list) or len(paths) > 24 or len(set(paths)) != len(paths): raise ValueError('Receipt cap')
        return {'files': [inspect(p) for p in paths]}
    raise ValueError('Unknown read operation')

if __name__ == '__main__':
    try:
        raw = base64.b64decode(sys.argv[1], validate=True)
        if len(raw) > 30000: raise ValueError('Input cap')
        print(json.dumps(execute(json.loads(raw)), ensure_ascii=True))
    except Exception:
        print(json.dumps({'error': 'Private file observation rejected; inspect exact path, source and limits'})); sys.exit(1)
