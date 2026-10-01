#!/usr/bin/env python3
"""Preserve native build outputs when regenerated content is unchanged."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


def file_digest(filename):
    digest = hashlib.sha256()
    with Path(filename).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def remove_entry(filename):
    if filename.is_dir() and not filename.is_symlink():
        shutil.rmtree(filename)
    else:
        filename.unlink()


def sync_file(source, destination):
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    exists = destination.exists() or destination.is_symlink()
    if source.is_symlink():
        link = os.readlink(source)
        if destination.is_symlink() and os.readlink(destination) == link:
            return
        if exists:
            remove_entry(destination)
        destination.symlink_to(link)
        return
    if exists and (destination.is_symlink() or not destination.is_file()):
        remove_entry(destination)
    elif exists and source.stat().st_size == destination.stat().st_size:
        if file_digest(source) == file_digest(destination):
            # An executable-bit change must propagate without touching mtime.
            source_mode = source.stat().st_mode & 0o777
            if destination.stat().st_mode & 0o777 != source_mode:
                destination.chmod(source_mode)
            return
    descriptor, temporary = tempfile.mkstemp(prefix=".lvn-sync-", dir=destination.parent)
    os.close(descriptor)
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sync_tree(source, destination):
    source, destination = Path(source), Path(destination)
    if not source.is_dir() or source.is_symlink():
        raise ValueError(f"Expected a generated source directory: {source}")
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        remove_entry(destination)
    destination.mkdir(parents=True, exist_ok=True)
    children = {item.name for item in source.iterdir()}
    for item in source.iterdir():
        target = destination / item.name
        if item.is_dir() and not item.is_symlink():
            sync_tree(item, target)
        else:
            sync_file(item, target)
    for item in destination.iterdir():
        if item.name not in children:
            remove_entry(item)


def input_key(profile, filenames):
    # This key only decides packaging reuse after Cargo has checked all inputs.
    inputs = [(str(Path(filename)), file_digest(filename)) for filename in filenames]
    return hashlib.sha256(json.dumps([profile, inputs], separators=(",", ":")).encode()).hexdigest()


def tree_digest(directory):
    directory = Path(directory)
    if not directory.is_dir() or directory.is_symlink():
        return None
    entries = []
    for item in sorted(directory.rglob("*")):
        relative = str(item.relative_to(directory))
        if item.is_symlink():
            entries.append([relative, "link", os.readlink(item)])
        elif item.is_file():
            entries.append([relative, "file", file_digest(item), item.stat().st_mode & 0o777])
        elif item.is_dir():
            entries.append([relative, "directory"])
        else:
            return None
    if not entries:
        return None
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def package_valid(state, key, artifact):
    try:
        saved = json.loads(Path(state).read_text())
        actual = tree_digest(artifact)
        return saved.get("key") == key and actual is not None and saved.get("artifact") == actual
    except (OSError, ValueError, AttributeError):
        return False


def record_package(state, key, artifact):
    digest = tree_digest(artifact)
    if digest is None:
        raise ValueError(f"Expected a complete, nonempty artifact: {artifact}")
    state = Path(state)
    state.parent.mkdir(parents=True, exist_ok=True)
    contents = json.dumps({"key": key, "artifact": digest}, sort_keys=True) + "\n"
    if state.exists() and state.read_text() == contents:
        return
    descriptor, temporary = tempfile.mkstemp(prefix=".lvn-state-", dir=state.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(contents)
        os.replace(temporary, state)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name in ("sync-file", "sync-tree"):
        command = subcommands.add_parser(name)
        command.add_argument("source")
        command.add_argument("destination")
    command = subcommands.add_parser("input-key")
    command.add_argument("profile")
    command.add_argument("files", nargs="+")
    for name in ("package-valid", "record-package"):
        command = subcommands.add_parser(name)
        command.add_argument("state")
        command.add_argument("key")
        command.add_argument("artifact")
    args = parser.parse_args()
    if args.command == "sync-file":
        if Path(args.destination).is_dir() and not Path(args.destination).is_symlink():
            parser.error("sync-file destination must include a filename, not an existing directory")
        sync_file(args.source, args.destination)
    elif args.command == "sync-tree":
        sync_tree(args.source, args.destination)
    elif args.command == "input-key":
        print(input_key(args.profile, args.files))
    elif args.command == "package-valid":
        return 0 if package_valid(args.state, args.key, args.artifact) else 1
    else:
        record_package(args.state, args.key, args.artifact)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
