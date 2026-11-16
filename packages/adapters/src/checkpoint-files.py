"""Bounded checkpoint transfer. The caller must stop workspace writers first."""
import base64
import hashlib
import json
import os
import stat
import sys
import tempfile
import zlib

ROOT = '/home/rakazo/workspace'
CHUNK = 48 * 1024
READ_CHUNK = 512 * 1024
EXCLUDED_DIRS = {'__pycache__', '.pytest_cache', 'node_modules', '.venv'}


def excluded(name, info):
    return (stat.S_ISDIR(info.st_mode) and name in EXCLUDED_DIRS) or (stat.S_ISREG(info.st_mode) and name.endswith('.tmp'))


def components(value):
    if not isinstance(value, str) or len(value) > 1000 or '\\' in value or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid checkpoint path')
    parts = value.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('Invalid checkpoint path')
    return parts


def root():
    parent = os.open(os.path.dirname(ROOT), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        return os.open(os.path.basename(ROOT), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)


def parent_for(path):
    parts = components(path)
    fd = root()
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except Exception:
        os.close(fd)
        raise


def regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('Checkpoint requires regular files without hard links')
    return info


def inventory():
    entries = []
    def walk(fd, prefix, depth):
        if depth > 32:
            raise ValueError('Checkpoint directory depth limit')
        for name in sorted(os.listdir(fd)):
            relative = prefix + name
            components(relative)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if excluded(name, info):
                continue
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    entries.append({'path': relative, 'type': 'directory', 'mode': stat.S_IMODE(info.st_mode) & 0o777})
                    walk(child, relative + '/', depth + 1)
                finally:
                    os.close(child)
            else:
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    before = regular(child)
                    sha = hashlib.sha256()
                    size = 0
                    while True:
                        chunk = os.read(child, CHUNK)
                        if not chunk:
                            break
                        size += len(chunk)
                        sha.update(chunk)
                    after = regular(child)
                    if (before.st_ino, before.st_mtime_ns, before.st_size) != (after.st_ino, after.st_mtime_ns, after.st_size):
                        raise ValueError('Workspace changed during checkpoint')
                    entries.append({'path': relative, 'type': 'file', 'mode': stat.S_IMODE(after.st_mode) & 0o777, 'size': size, 'sha256': sha.hexdigest()})
                finally:
                    os.close(child)
    fd = root()
    try:
        walk(fd, '', 0)
    finally:
        os.close(fd)
    return {'entries': entries}


def clear():
    # Validate the complete tree before deleting anything. Never follow links.
    inventory()
    def remove(fd):
        for name in sorted(os.listdir(fd)):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if excluded(name, info):
                continue
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    remove(child)
                finally:
                    os.close(child)
                try:
                    os.rmdir(name, dir_fd=fd)
                except OSError as error:
                    import errno
                    if error.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                        raise
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                os.unlink(name, dir_fd=fd)
            else:
                raise ValueError('Workspace contains unsupported entry')
    fd = root()
    try:
        remove(fd)
    finally:
        os.close(fd)
    preserved = inventory()['entries']
    if any(item['type'] != 'directory' for item in preserved):
        raise ValueError('Workspace changed during checkpoint restore')
    return {'preservedDirectories': preserved}


def verify_restored(entries, preserved):
    # Only ancestors left by clear for excluded caches/files may sit outside the target manifest.
    target_paths = {item['path'] for item in entries}
    allowed = {item['path']: item for item in preserved if item['path'] not in target_paths}
    actual = inventory()['entries']
    extras = [item for item in actual if item['path'] in allowed]
    if {item['path']: item for item in extras} != allowed or [item for item in actual if item['path'] not in allowed] != entries:
        raise ValueError('Restored workspace verification failed')


def execute(value):
    operation = value['operation']
    if operation == 'inventory':
        return inventory()
    if operation == 'clear':
        return clear()
    parent, name = parent_for(value['path'])
    try:
        if operation == 'directory':
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
            except FileExistsError:
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(fd)
            return {}
        if operation == 'mode':
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                os.fchmod(fd, int(value['mode']) & 0o777)
            finally:
                os.close(fd)
            return {}
        flags = os.O_RDONLY if operation == 'read' else os.O_WRONLY
        if operation == 'begin':
            flags |= os.O_CREAT | os.O_EXCL
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        try:
            info = regular(fd)
            if operation == 'begin':
                return {}
            offset = value.get('offset', 0)
            if not isinstance(offset, int) or offset < 0:
                raise ValueError('Invalid checkpoint offset')
            if operation == 'read':
                os.lseek(fd, offset, os.SEEK_SET)
                return {'data': base64.b64encode(os.read(fd, READ_CHUNK)).decode('ascii')}
            if operation == 'write':
                data = base64.b64decode(value['data'], validate=True)
                if len(data) > CHUNK or info.st_size != offset:
                    raise ValueError('Invalid checkpoint chunk')
                os.lseek(fd, offset, os.SEEK_SET)
                remaining = memoryview(data)
                while remaining:
                    written = os.write(fd, remaining)
                    remaining = remaining[written:]
                return {}
            raise ValueError('Unsupported checkpoint operation')
        finally:
            os.close(fd)
    finally:
        os.close(parent)


MAGIC = b'RKCZ1\0'
COMPRESSED = {'.xlsx', '.xlsm', '.docx', '.pptx', '.pdf', '.zip', '.gz', '.7z', '.png', '.jpg', '.jpeg', '.webp', '.mp4'}

def blob_chunks(filename, item):
    with os.fdopen(os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('Invalid checkpoint blob')
        head = f.read(len(MAGIC))
        f.seek(0)
        compressed = head == MAGIC
        if compressed and info.st_size == item['size']:
            h = hashlib.sha256()
            for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
            compressed = h.hexdigest() != item['sha256']
            f.seek(0)
        decoder = zlib.decompressobj() if compressed else None
        if decoder: f.read(len(MAGIC))
        h = hashlib.sha256()
        size = 0
        for chunk in iter(lambda: f.read(256 * 1024), b''):
            while chunk:
                data = decoder.decompress(chunk, min(1024 * 1024, max(1, item['size'] - size + 1))) if decoder else chunk
                chunk = decoder.unconsumed_tail if decoder else b''
                size += len(data)
                if size > item['size']: raise ValueError('Checkpoint blob integrity check failed')
                h.update(data)
                yield data
        if decoder and (not decoder.eof or decoder.unused_data): raise ValueError('Checkpoint blob integrity check failed')
        if size != item['size'] or h.hexdigest() != item['sha256']: raise ValueError('Checkpoint blob integrity check failed')

def direct_capture(pool):
    entries = inventory()['entries']
    for item in entries:
        if item['type'] != 'file': continue
        target = os.path.join(pool, item['sha256'])
        try:
            for _ in blob_chunks(target, item): pass
            continue
        except FileNotFoundError: pass
        parent, name = parent_for(item['path'])
        temp = None
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                before = regular(fd)
                outfd, temp = tempfile.mkstemp(prefix='.tmp-', dir=pool)
                with os.fdopen(outfd, 'wb') as out:
                    compressor = None if os.path.splitext(name)[1].lower() in COMPRESSED else zlib.compressobj(1)
                    if compressor: out.write(MAGIC)
                    h = hashlib.sha256(); size = 0
                    while True:
                        chunk = os.read(fd, 1024 * 1024)
                        if not chunk: break
                        size += len(chunk); h.update(chunk)
                        out.write(compressor.compress(chunk) if compressor else chunk)
                    if compressor: out.write(compressor.flush())
                after = regular(fd)
                if size != item['size'] or h.hexdigest() != item['sha256'] or (before.st_ino, before.st_mtime_ns, before.st_size) != (after.st_ino, after.st_mtime_ns, after.st_size):
                    raise ValueError('Workspace changed during checkpoint')
                try: os.link(temp, target)
                except FileExistsError:
                    for _ in blob_chunks(target, item): pass
            finally: os.close(fd)
        finally:
            os.close(parent)
            if temp: os.unlink(temp)
    if inventory()['entries'] != entries: raise ValueError('Workspace changed during checkpoint')
    return {'entries': entries}

def direct_restore(pool, entries):
    verified = set()
    for item in entries:
        if item['type'] == 'file' and item['sha256'] not in verified:
            for _ in blob_chunks(os.path.join(pool, item['sha256']), item): pass
            verified.add(item['sha256'])
    cleared = clear()
    directories = sorted((x for x in entries if x['type'] == 'directory'), key=lambda x: x['path'].count('/'))
    for item in directories: execute({'operation': 'directory', 'path': item['path']})
    for item in entries:
        if item['type'] != 'file': continue
        parent, name = parent_for(item['path'])
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                for chunk in blob_chunks(os.path.join(pool, item['sha256']), item):
                    view = memoryview(chunk)
                    while view: view = view[os.write(fd, view):]
                os.fchmod(fd, item['mode'])
            finally: os.close(fd)
        finally: os.close(parent)
    for item in reversed(directories): execute({'operation': 'mode', 'path': item['path'], 'mode': item['mode']})
    verify_restored(entries, cleared['preservedDirectories'])
    return {}


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == '--direct':
            ROOT = sys.argv[2]
            request = json.load(sys.stdin)
            result = direct_capture(sys.argv[3]) if request['operation'] == 'capture' else direct_restore(sys.argv[3], request['entries'])
            print(json.dumps(result, ensure_ascii=True))
            sys.exit(0)
        raw = base64.b64decode(sys.argv[1], validate=True)
        if len(raw) > 80000:
            raise ValueError('Checkpoint request limit')
        print(json.dumps(execute(json.loads(raw)), ensure_ascii=True))
    except Exception as error:
        print(json.dumps({'error': str(error)[:200]}))
        sys.exit(1)
