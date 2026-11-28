"""Bounded checkpoint transfer. The caller must stop workspace writers first."""
import base64
from contextlib import contextmanager
import ctypes
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import time
import uuid
import zlib

ROOT = '/home/rakazo/workspace'
SELECTED_ROOTS = None
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


def configure(value, direct=False):
    global ROOT, SELECTED_ROOTS
    selected = value.get('roots')
    if selected is None:
        SELECTED_ROOTS = None
        return
    if not isinstance(selected, list) or len(selected) != 1:
        raise ValueError('Invalid Team checkpoint roots')
    parts = components(selected[0])
    if len(parts) != 2 or parts[0] != 'bots' or len(parts[1]) > 160 or not all(c in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in parts[1]):
        raise ValueError('Invalid Team checkpoint roots')
    SELECTED_ROOTS = selected
    if not direct: ROOT = '/home/rakazo'


def managed(value):
    components(value)
    return SELECTED_ROOTS is None or any(value == selected or value.startswith(selected + '/') for selected in SELECTED_ROOTS)


def root():
    parent = os.open(os.path.dirname(ROOT), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        return os.open(os.path.basename(ROOT), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)


def parent_for(path, create_parents=False):
    if not managed(path): raise ValueError('Path is outside the Team checkpoint roots')
    parts = components(path)
    fd = root()
    try:
        for index, part in enumerate(parts[:-1]):
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                prefix = '/'.join(parts[:index + 1])
                if not create_parents or SELECTED_ROOTS is None or not any(selected.startswith(prefix + '/') for selected in SELECTED_ROOTS): raise
                try: os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError: pass
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
    if SELECTED_ROOTS is None:
        fd = root()
        try: walk(fd, '', 0)
        finally: os.close(fd)
    else:
        for selected in SELECTED_ROOTS:
            try: parent, name = parent_for(selected)
            except FileNotFoundError: continue
            try:
                try: info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError: continue
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    entries.append({'path': selected, 'type': 'directory', 'mode': stat.S_IMODE(info.st_mode) & 0o777})
                    walk(child, selected + '/', 0)
                finally: os.close(child)
            finally: os.close(parent)
    return {'entries': entries}


def verify_restored(entries, preserved):
    # Only ancestors left by clear for excluded caches/files may sit outside the target manifest.
    target_paths = {item['path'] for item in entries}
    allowed = {item['path']: item for item in preserved if item['path'] not in target_paths}
    actual = inventory()['entries']
    extras = [item for item in actual if item['path'] in allowed]
    if {item['path']: item for item in extras} != allowed or [item for item in actual if item['path'] not in allowed] != entries:
        raise ValueError('Restored workspace verification failed')


def stage_paths(token):
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{32}', token):
        raise ValueError('Invalid checkpoint stage')
    live = ROOT if SELECTED_ROOTS is None else os.path.join(ROOT, SELECTED_ROOTS[0])
    parent, name = os.path.split(live)
    stage = os.path.join(parent, '.' + name + '.checkpoint-' + token)
    staged_root = os.path.join(stage, 'tree')
    staged_live = staged_root if SELECTED_ROOTS is None else os.path.join(staged_root, SELECTED_ROOTS[0])
    return live, stage, staged_root, staged_live


@contextmanager
def in_stage(token):
    global ROOT
    previous = ROOT
    _, stage, staged_root, _ = stage_paths(token)
    for item in (stage, staged_root):
        if not stat.S_ISDIR(os.lstat(item).st_mode):
            raise ValueError('Invalid checkpoint staging directory')
    ROOT = staged_root
    try:
        yield
    finally:
        ROOT = previous


def prepare_stage(token):
    live, stage, staged_root, _ = stage_paths(token)
    if SELECTED_ROOTS is not None:
        try: os.mkdir(os.path.dirname(live), 0o700)
        except FileExistsError: pass
        if not stat.S_ISDIR(os.lstat(os.path.dirname(live)).st_mode):
            raise ValueError('Invalid Team checkpoint parent')
    os.mkdir(stage, 0o700)
    os.mkdir(staged_root, 0o700)
    return {}


@contextmanager
def publication_lock(live):
    parent, name = os.path.split(live)
    lock = os.path.join(parent, '.' + name + '.checkpoint-lock')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        regular(fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def discard_stage(token):
    live, stage, _, _ = stage_paths(token)
    with publication_lock(live):
        return remove_stage(stage)


def remove_stage(stage):
    if not os.path.lexists(stage):
        return {}
    if not stat.S_ISDIR(os.lstat(stage).st_mode):
        raise ValueError('Invalid checkpoint staging directory')
    refuse_nested_mounts(stage)
    device = os.lstat(stage).st_dev
    for current, _, _ in os.walk(stage, topdown=True, followlinks=False):
        info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or info.st_dev != device or os.path.ismount(current):
            raise ValueError('Cannot clean a mounted checkpoint tree')
        os.chmod(current, stat.S_IMODE(info.st_mode) | 0o700)
    shutil.rmtree(stage)
    return {}


def refuse_nested_mounts(path):
    if not sys.platform.startswith('linux'):
        return
    prefix = os.path.realpath(path) + '/'
    with open('/proc/self/mountinfo', encoding='utf-8', errors='surrogateescape') as mounts:
        for line in mounts:
            target = line.split(' ', 5)[4]
            target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), target)
            if target.startswith(prefix):
                raise ValueError('Cannot replace a checkpoint workspace with nested mounts')


def copy_excluded(live, staged, entries):
    """Preserve excluded files and their ancestors without modifying the live tree."""
    wanted = {item['path'] for item in entries}
    preserved = []
    prefix = SELECTED_ROOTS[0] if SELECTED_ROOTS else ''

    def walk(src, dst, relative):
        info = os.lstat(src)
        if not stat.S_ISDIR(info.st_mode) or info.st_dev != device:
            raise ValueError('Invalid checkpoint source directory')
        has_exclusions = False
        for child in sorted(os.scandir(src), key=lambda item: item.name):
            child_info = child.stat(follow_symlinks=False)
            target = os.path.join(dst, child.name)
            if excluded(child.name, child_info):
                if child_info.st_dev != device:
                    raise ValueError('Cannot preserve a mounted checkpoint directory')
                os.makedirs(dst, mode=0o700, exist_ok=True)
                if os.path.lexists(target):
                    raise ValueError('Checkpoint conflicts with an excluded workspace entry')
                if child.is_dir(follow_symlinks=False):
                    shutil.copytree(child.path, target, symlinks=True)
                else:
                    shutil.copy2(child.path, target, follow_symlinks=False)
                has_exclusions = True
            elif child.is_dir(follow_symlinks=False):
                name = relative + '/' + child.name if relative else child.name
                has_exclusions = walk(child.path, target, name) or has_exclusions
        if has_exclusions and relative and relative not in wanted:
            mode = stat.S_IMODE(info.st_mode) & 0o777
            preserved.append({'path': relative, 'type': 'directory', 'mode': mode})
        return has_exclusions

    if os.path.lexists(live):
        device = os.lstat(live).st_dev
        walk(live, staged, prefix)
    return preserved


def exchange_directories(left, right):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith('linux'):
        rename = getattr(libc, 'renameat2', None)
        at_cwd = -100
    elif sys.platform == 'darwin':
        rename = getattr(libc, 'renameatx_np', None)
        at_cwd = -2
    else:
        rename = None
    if rename is None:
        raise ValueError('This filesystem runtime does not support atomic checkpoint replacement')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(at_cwd, os.fsencode(left), at_cwd, os.fsencode(right), 2) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def publish_stage(token, entries, generation=None):
    live, stage, _, staged_live = stage_paths(token)
    if generation is not None and (type(generation) is not int or not 0 <= generation <= 2**31 - 1):
        raise ValueError('Invalid checkpoint generation')
    if any(not managed(item['path']) for item in entries):
        raise ValueError('Path is outside the Team checkpoint roots')
    parent, name = os.path.split(live)
    fence = os.path.join(parent, '.' + name + '.checkpoint-generation')
    with publication_lock(live):
        if generation is not None:
            try:
                previous = os.open(fence, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except FileNotFoundError:
                pass
            else:
                with os.fdopen(previous, 'rb') as stream:
                    regular(stream.fileno())
                    value = stream.read(32)
                if not re.fullmatch(rb'[0-9]{1,10}\n', value):
                    raise ValueError('Invalid checkpoint generation fence')
                if int(value) >= generation:
                    raise ValueError('A newer checkpoint restore has already reached publication')
        # No operation before exchange may modify files within the current workspace.
        refuse_nested_mounts(live)
        inventory()
        preserved = copy_excluded(live, staged_live, entries)
        with in_stage(token):
            for item in sorted(
                [x for x in entries if x['type'] == 'directory'] + preserved,
                key=lambda x: -x['path'].count('/'),
            ):
                execute({'operation': 'mode', 'path': item['path'], 'mode': item['mode']})
            verify_restored(entries, preserved)
        live_exists = os.path.lexists(live)
        staged_exists = bool(entries or preserved) or SELECTED_ROOTS is None
        if staged_exists and not os.path.isdir(staged_live):
            raise ValueError('Verified staged workspace disappeared')
        if live_exists and staged_exists:
            existing, candidate = os.lstat(live), os.lstat(staged_live)
            if (existing.st_uid, existing.st_gid) != (candidate.st_uid, candidate.st_gid):
                os.chown(staged_live, existing.st_uid, existing.st_gid)
            if SELECTED_ROOTS is None:
                os.chmod(staged_live, stat.S_IMODE(existing.st_mode) & 0o777)
        if generation is not None:
            marker = os.path.join(stage, 'generation')
            with open(marker, 'x', encoding='ascii') as out:
                out.write(str(generation) + '\n')
                out.flush()
                os.fsync(out.fileno())
            os.replace(marker, fence)
        if live_exists and staged_exists:
            exchange_directories(live, staged_live)
        elif live_exists:
            os.makedirs(os.path.dirname(staged_live), mode=0o700, exist_ok=True)
            os.rename(live, staged_live)
        elif staged_exists:
            os.rename(staged_live, live)
        return {}


def dispatch(value):
    operation, token = value['operation'], value.get('stage')
    if operation == 'stage_prepare': return prepare_stage(token)
    if operation in ('stage_manifest', 'stage_publish'):
        _, stage, _, _ = stage_paths(token)
        if not stat.S_ISDIR(os.lstat(stage).st_mode):
            raise ValueError('Invalid checkpoint staging directory')
        path = os.path.join(stage, 'manifest')
        if operation == 'stage_manifest':
            data = base64.b64decode(value['data'], validate=True)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'ab') as out:
                actual = regular(out.fileno()).st_size
                if actual != value['offset'] or len(data) > CHUNK or actual + len(data) > 32 * 1024**2:
                    raise ValueError('Invalid staged checkpoint manifest chunk')
                out.write(data)
            return {}
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
            if regular(stream.fileno()).st_size > 32 * 1024**2:
                raise ValueError('Checkpoint manifest too large')
            entries = json.load(stream)
        return publish_stage(token, entries, value.get('generation'))
    if operation == 'stage_discard': return discard_stage(token)
    if token is None: return execute(value)
    if operation not in ('directory', 'begin', 'write', 'mode'):
        raise ValueError('Invalid checkpoint staging operation')
    with in_stage(token):
        return execute(value)


def execute(value):
    operation = value['operation']
    if operation == 'inventory':
        return inventory()
    parent, name = parent_for(value['path'], create_parents=operation == 'directory')
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
            verify_published_blob(target, item)
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
                    verify_published_blob(target, item)
            finally: os.close(fd)
        finally:
            os.close(parent)
            if temp: os.unlink(temp)
    if inventory()['entries'] != entries: raise ValueError('Workspace changed during checkpoint')
    return {'entries': entries}


def verify_published_blob(target, item):
    for attempt in range(6):
        try:
            for _ in blob_chunks(target, item): pass
            return
        except ValueError as error:
            if attempt == 5 or str(error) != 'Invalid checkpoint blob':
                raise
            info = os.lstat(target)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 2:
                raise
            time.sleep(0.02)

def direct_restore(pool, entries, generation=None):
    if any(not managed(item['path']) for item in entries): raise ValueError('Path is outside the Team checkpoint roots')
    verified = set()
    for item in entries:
        if item['type'] == 'file' and item['sha256'] not in verified:
            for _ in blob_chunks(os.path.join(pool, item['sha256']), item): pass
            verified.add(item['sha256'])
    token = uuid.uuid4().hex
    prepare_stage(token)
    try:
        with in_stage(token):
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
        return publish_stage(token, entries, generation)
    finally:
        try: discard_stage(token)
        except (OSError, ValueError): pass


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == '--direct':
            ROOT = sys.argv[2]
            request = json.load(sys.stdin)
            configure(request, direct=True)
            result = direct_capture(sys.argv[3]) if request['operation'] == 'capture' else direct_restore(sys.argv[3], request['entries'], request.get('generation'))
            print(json.dumps(result, ensure_ascii=True))
            sys.exit(0)
        raw = base64.b64decode(sys.argv[1], validate=True)
        if len(raw) > 80000:
            raise ValueError('Checkpoint request limit')
        request = json.loads(raw)
        configure(request)
        print(json.dumps(dispatch(request), ensure_ascii=True))
    except Exception as error:
        print(json.dumps({'error': str(error)[:200]}))
        sys.exit(1)
