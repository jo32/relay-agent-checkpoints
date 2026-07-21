#!/usr/bin/env python3
"""Create a sanitized, immutable agent workspace checkpoint."""

from __future__ import annotations

import argparse
import io
import json
import os
import secrets
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from checkpoint_lib import (
    FORMAT_VERSION,
    json_bytes,
    safe_slug,
    select_files,
    sha256_file,
)
from relay_crypto import (
    RelayCryptoError,
    encrypt_checkpoint,
    generate_checkpoint_key,
    prompt_checkpoint_key,
    save_checkpoint_key,
)
from relay_credentials import RelayCredentialError, load_access_token
from relay_upload import RelayUploadError, upload_checkpoint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Project directory")
    parser.add_argument("--label", default="agent-handoff")
    parser.add_argument("--handoff-file", type=Path)
    parser.add_argument("--parent")
    parser.add_argument("--source-agent", default=os.environ.get("RELAY_SOURCE_AGENT", "Agent skill"))
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--write-gitignore", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    key_mode = parser.add_mutually_exclusive_group()
    key_mode.add_argument(
        "--generate-key",
        action="store_const",
        const="generate",
        dest="key_mode",
        help="Generate and securely save a recovery key without prompting (default)",
    )
    key_mode.add_argument(
        "--prompt-key",
        action="store_const",
        const="prompt",
        dest="key_mode",
        help="Ask for a user-chosen key through the hidden local prompt",
    )
    parser.set_defaults(key_mode="generate")
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def add_bytes(archive: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    archive.addfile(info, io.BytesIO(data))


def main() -> int:
    args = parse_args()
    root = args.root.expanduser().resolve()
    included, excluded, context = select_files(root)
    created_at = datetime.now(timezone.utc).isoformat()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    checkpoint_id = f"cp_{secrets.token_hex(16)}"
    label = args.label.strip() or "agent-handoff"
    output_dir = (
        args.output_dir.expanduser()
        if args.output_dir
        else Path.home() / ".agent-checkpoints" / safe_slug(root.name)
    )
    archive_path = output_dir / f"{timestamp}-{safe_slug(label)}.relay"
    upload_token: str | None = None
    if args.upload:
        if not args.api_url:
            raise SystemExit("Upload requires RELAY_API_URL (or --api-url).")
        try:
            upload_token = load_access_token(args.api_url, args.api_token)
        except RelayCredentialError as error:
            raise SystemExit(str(error)) from error

    handoff_text = (
        args.handoff_file.read_text(encoding="utf-8")
        if args.handoff_file
        else "Continue from this checkpoint. Inspect repository instructions and validation state before editing."
    )
    manifest = {
        "formatVersion": FORMAT_VERSION,
        "checkpointId": checkpoint_id,
        "createdAt": created_at,
        "workspace": root.name,
        "root": ".",
        "label": label,
        "sourceAgent": args.source_agent,
        "baseSnapshot": args.parent,
        "treeHash": f"sha256:{context['treeHash']}",
        "stacks": context["stacks"],
        "git": context["git"],
        "files": [
            {
                "path": item.path,
                "size": item.size,
                "mode": item.mode,
                "sha256": f"sha256:{item.sha256}",
            }
            for item in included
        ],
        "exclusions": [{"path": item.path, "reason": item.reason} for item in excluded],
    }
    handoff = "\n".join(
        [
            f"# {label}",
            "",
            f"- Workspace: **{root.name}**",
            f"- Created: {created_at}",
            f"- Created by: **{args.source_agent}**",
            f"- Parent checkpoint: {args.parent or 'none'}",
            f"- Included: {len(included)} files",
            f"- Excluded: {len(excluded)} files",
            f"- Tree hash: `sha256:{context['treeHash']}`",
            "",
            "## Current objective and next steps",
            "",
            handoff_text.strip(),
            "",
            "## Restore checklist",
            "",
            "1. Read repository instructions such as `AGENTS.md` or `CLAUDE.md`.",
            "2. Reinstall dependencies from the committed lockfile.",
            "3. Run the project validation commands before editing.",
            "4. Create a child checkpoint after completing the handoff.",
            "",
        ]
    )

    if args.write_gitignore and not (root / ".gitignore").exists():
        (root / ".gitignore").write_text("\n".join(context["inferredRules"]) + "\n", encoding="utf-8")

    summary = {
        "checkpointId": checkpoint_id,
        "archive": None if args.dry_run else str(archive_path),
        "includedFiles": len(included),
        "includedBytes": sum(item.size for item in included),
        "excludedFiles": len(excluded),
        "stacks": context["stacks"],
        "treeHash": f"sha256:{context['treeHash']}",
        "encrypted": True,
        "encryptionVersion": 2,
        "cipher": "AES-256-GCM",
        "keyMode": args.key_mode,
        "keyGenerated": False,
        "keyStored": False,
        "keyFile": None,
        "dryRun": args.dry_run,
        "uploaded": False,
        "exclusions": [{"path": item.path, "reason": item.reason} for item in excluded],
    }

    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)
        generated_key_path: Path | None = None
        try:
            if args.key_mode == "generate":
                checkpoint_key = generate_checkpoint_key()
                generated_key_path = save_checkpoint_key(
                    checkpoint_id,
                    checkpoint_key,
                )
            else:
                checkpoint_key = prompt_checkpoint_key()
            with tempfile.TemporaryDirectory(
                prefix="relay-checkpoint-"
            ) as temporary:
                plaintext_path = Path(temporary) / "checkpoint.tar.gz"
                with tarfile.open(
                    plaintext_path,
                    "w:gz",
                    format=tarfile.PAX_FORMAT,
                ) as archive:
                    for item in included:
                        info = tarfile.TarInfo(item.path)
                        info.size = item.size
                        info.mode = item.mode
                        info.mtime = 0
                        with item.source.open("rb") as source:
                            archive.addfile(info, source)
                    add_bytes(
                        archive,
                        ".agent-checkpoint/manifest.json",
                        json_bytes(manifest),
                    )
                    add_bytes(
                        archive,
                        ".agent-checkpoint/HANDOFF.md",
                        handoff.encode("utf-8"),
                    )
                    add_bytes(
                        archive,
                        ".agent-checkpoint/inferred.gitignore",
                        (
                            "\n".join(context["inferredRules"]) + "\n"
                        ).encode("utf-8"),
                    )
                    add_bytes(
                        archive,
                        ".agent-checkpoint/README.md",
                        b"# Agent workspace checkpoint\n\nRead HANDOFF.md before editing. Verify manifest hashes when restoring.\n",
                    )
                encrypt_checkpoint(
                    plaintext_path,
                    archive_path,
                    checkpoint_id,
                    checkpoint_key,
                )
        except (OSError, RelayCryptoError, tarfile.TarError) as error:
            archive_path.unlink(missing_ok=True)
            if generated_key_path is not None:
                generated_key_path.unlink(missing_ok=True)
            raise SystemExit(str(error)) from error

        if generated_key_path is not None:
            summary["keyGenerated"] = True
            summary["keyStored"] = True
            summary["keyFile"] = str(generated_key_path)

        archive_hash = sha256_file(archive_path)
        sidecar = archive_path.with_name(archive_path.name + ".sha256")
        sidecar.write_text(f"{archive_hash}  {archive_path.name}\n", encoding="utf-8")
        summary["archiveSha256"] = f"sha256:{archive_hash}"
        summary["sidecar"] = str(sidecar)
        if args.upload:
            try:
                upload_result = upload_checkpoint(
                    archive_path=archive_path,
                    api_url=args.api_url,
                    api_token=upload_token,
                    checkpoint_id=checkpoint_id,
                    checksum=summary["archiveSha256"],
                )
            except (OSError, RelayUploadError) as error:
                raise SystemExit(str(error)) from error
            summary["uploaded"] = True
            summary["relay"] = upload_result

    if args.json_output:
        print(json.dumps(summary, indent=2))
    else:
        verb = "Would include" if args.dry_run else "Created"
        print(f"{verb} {len(included)} files; excluded {len(excluded)} files.")
        print(f"Tree hash: {summary['treeHash']}")
        if not args.dry_run:
            print(f"Archive: {archive_path}")
            print(f"Checksum: {summary['archiveSha256']}")
            if summary["keyStored"]:
                print(f"Recovery key: generated and saved to {summary['keyFile']}")
                print("Keep the recovery key file private and backed up separately.")
            else:
                print("Encryption key: not stored; enter the same key to restore.")
            if summary["uploaded"]:
                print(f"Relay checkpoint: {summary['relay']['checkpoint']['id']}")
        if excluded:
            print("Excluded:")
            for item in excluded[:40]:
                print(f"  - {item.path}: {item.reason}")
            if len(excluded) > 40:
                print(f"  … and {len(excluded) - 40} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
