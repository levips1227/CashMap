"""Complete local backup/restore. Requires Python 3; no installed packages needed."""
import io
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(archive):
    with zipfile.ZipFile(io.BytesIO(Path(archive).read_bytes())) as z:
        manifest = json.loads(z.read('manifest.json'))
        for name, expected in manifest['files'].items():
            if digest(z.read('project/' + name)) != expected:
                raise RuntimeError('Checksum failed: ' + name)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'verify', 'restore'])
    parser.add_argument('archive', nargs='?')
    parser.add_argument('--target', help='Restore into a NEW, empty/nonexistent directory')
    args = parser.parse_args()
    if args.action == 'backup':
        root = Path(__file__).resolve().parent.parent
        destination = root.parent / 'CashMap-backups'
        destination.mkdir(exist_ok=True)
        archive = destination / ('CashMap-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.zip')
        manifest = {'source': str(root), 'created': datetime.now().isoformat(), 'files': {}}
        for cmd in [['node', '--version'], ['npm.cmd' if os.name == 'nt' else 'npm', '--version'], ['git', 'rev-parse', 'HEAD']]:
            result = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
            manifest[' '.join(cmd)] = result.stdout.strip()
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as z:
            for current, dirs, files in os.walk(root):
                for name in dirs + files:
                    if (Path(current) / name).is_symlink():
                        raise RuntimeError('External/link path requires explicit backup handling: ' + str(Path(current) / name))
                for name in files:
                    path = Path(current) / name
                    relative = path.relative_to(root).as_posix()
                    data = path.read_bytes()
                    manifest['files'][relative] = digest(data)
                    z.writestr('project/' + relative, data)
            z.writestr('manifest.json', json.dumps(manifest, indent=2))
        verify(archive)
        # Compare every source file again to detect writes during backup.
        actual = {p.relative_to(root).as_posix(): digest(p.read_bytes()) for p in root.rglob('*') if p.is_file()}
        if actual != manifest['files']:
            raise RuntimeError('Source changed during backup; stop the app and retry.')
        print(f'VERIFIED: {archive}\nFiles: {len(actual)}; bytes: {archive.stat().st_size}')
        return
    if not args.archive:
        parser.error('archive is required')
    manifest = verify(args.archive)
    if args.action == 'verify':
        print('VERIFIED:', len(manifest['files']), 'files')
        return
    if not args.target:
        parser.error('--target is required; stop the app before restoring')
    target = Path(args.target).resolve()
    if target.exists() and any(target.iterdir()):
        raise RuntimeError('Restore target must be empty. Rename the current project first to preserve it.')
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(Path(args.archive).read_bytes())) as z:
        for name, expected in manifest['files'].items():
            path = (target / name).resolve()
            if not path.is_relative_to(target):
                raise RuntimeError('Unsafe archive path')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(z.read('project/' + name))
            if digest(path.read_bytes()) != expected:
                raise RuntimeError('Restore verification failed: ' + name)
    print('RESTORED AND VERIFIED:', target)


if __name__ == '__main__':
    main()
