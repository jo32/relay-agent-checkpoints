#!/usr/bin/env python3
"""Inspect and verify an agent workspace checkpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
from pathlib import Path

from checkpoint_lib import sha256_file, validate_member_name


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--show-excluded", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    archive_path = args.archive.expanduser().resolve()
    if not archive_path.is_file():
        raise SystemExit(f"Archive not found: {archive_path}")

    seen: set[str] = set()
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            name = validate_member_name(member.name)
            if name in seen:
                raise SystemExit(f"Duplicate archive member: {name}")
            seen.add(name)
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise SystemExit(f"Unsafe archive member type: {name}")
        manifest_member = archive.getmember(".agent-checkpoint/manifest.json")
        handle = archive.extractfile(manifest_member)
        if handle is None:
            raise SystemExit("Manifest is unreadable")
        manifest = json.load(handle)

        verified = 0
        errors: list[str] = []
        if args.verify:
            for expected in manifest.get("files", []):
                path = expected["path"]
                try:
                    member = archive.getmember(path)
                except KeyError:
                    errors.append(f"Missing file: {path}")
                    continue
                source = archive.extractfile(member)
                if source is None:
                    errors.append(f"Unreadable file: {path}")
                    continue
                digest = hashlib.sha256(source.read()).hexdigest()
                if f"sha256:{digest}" != expected["sha256"]:
                    errors.append(f"Hash mismatch: {path}")
                else:
                    verified += 1

    sidecar = archive_path.with_name(archive_path.name + ".sha256")
    archive_hash = sha256_file(archive_path)
    sidecar_ok: bool | None = None
    if sidecar.exists():
        expected_hash = sidecar.read_text(encoding="utf-8").split()[0]
        sidecar_ok = expected_hash == archive_hash
        if args.verify and not sidecar_ok:
            errors.append("Archive sidecar checksum mismatch")

    result = {
        "archive": str(archive_path),
        "archiveSha256": f"sha256:{archive_hash}",
        "sidecarVerified": sidecar_ok,
        "checkpointId": manifest.get("checkpointId"),
        "workspace": manifest.get("workspace"),
        "sourceAgent": manifest.get("sourceAgent"),
        "treeHash": manifest.get("treeHash"),
        "stacks": manifest.get("stacks", []),
        "includedFiles": len(manifest.get("files", [])),
        "excludedFiles": len(manifest.get("exclusions", [])),
        "verifiedFiles": verified,
        "errors": errors,
    }
    if args.show_excluded:
        result["exclusions"] = manifest.get("exclusions", [])

    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(f"Checkpoint: {result['checkpointId']}")
        print(f"Workspace: {result['workspace']}")
        print(f"Created by: {result['sourceAgent']}")
        print(f"Files: {result['includedFiles']} included, {result['excludedFiles']} excluded")
        print(f"Tree hash: {result['treeHash']}")
        if args.verify:
            print(f"Verified: {verified} files")
        if args.show_excluded:
            for item in result.get("exclusions", []):
                print(f"  - {item['path']}: {item['reason']}")
        for error in errors:
            print(f"ERROR: {error}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
