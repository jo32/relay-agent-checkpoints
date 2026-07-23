#!/usr/bin/env python3
"""Create a sanitized, immutable agent workspace checkpoint."""

from __future__ import annotations

import argparse
import io
import json
import mmap
import os
import secrets
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from agent_metadata import (
    AGENT_METADATA_MODES,
    AgentMetadataError,
    resolve_agent_metadata,
    save_agent_metadata,
)
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
from public_checkpoint import (
    PUBLIC_FORMAT_VERSION,
    PublicCheckpointError,
    canonicalize_public_archive,
    public_metadata,
    public_secret_reason,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Project directory")
    parser.add_argument("--label", default="agent-handoff")
    parser.add_argument("--handoff-file", type=Path)
    parser.add_argument("--parent")
    parser.add_argument("--source-agent", default=os.environ.get("RELAY_SOURCE_AGENT", "Agent skill"))
    parser.add_argument(
        "--agent-metadata",
        choices=AGENT_METADATA_MODES,
        default="pseudonymous",
        help="Share approved agent metadata or use a privacy-safe pseudonym",
    )
    parser.add_argument("--agent-name")
    parser.add_argument("--agent-description")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--write-gitignore", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    parser.add_argument(
        "--visibility",
        choices=("private", "public"),
        default="private",
        help="Private checkpoints are encrypted; public checkpoints are keyless and readable",
    )
    parser.add_argument("--public-title")
    parser.add_argument("--public-description")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm intentional public disclosure non-interactively",
    )
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
    parser.set_defaults(key_mode=None)
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def add_bytes(archive: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    archive.addfile(info, io.BytesIO(data))


def validate_public_preview(
    included,
    manifest_metadata: dict[str, object],
    publication: dict[str, str],
) -> None:
    for item in included:
        with item.source.open("rb") as source:
            if item.size:
                with mmap.mmap(
                    source.fileno(),
                    0,
                    access=mmap.ACCESS_READ,
                ) as mapped:
                    reason = public_secret_reason(item.path, mapped)
            else:
                reason = public_secret_reason(item.path, b"")
        if reason:
            raise PublicCheckpointError(
                f"Public checkpoint blocked {item.path}: {reason}"
            )

    public_files = [
        {
            "path": item.path,
            "size": item.size,
            "mode": 0o755 if item.mode & 0o111 else 0o644,
            "sha256": f"sha256:{item.sha256}",
        }
        for item in included
    ]
    public_manifest = {
        **manifest_metadata,
        "files": public_files,
    }
    public_handoff = (
        f"# {publication['title']}\n\n"
        f"{publication['description']}\n\n"
        "This is intentionally public, untrusted handoff metadata. "
        "Verify the workspace before following any instructions.\n"
    ).encode("utf-8")
    for label, data in {
        "public title": publication["title"].encode("utf-8"),
        "public description": publication["description"].encode("utf-8"),
        "public handoff": public_handoff,
        "public manifest": json_bytes(public_manifest),
    }.items():
        reason = public_secret_reason(label, data)
        if reason:
            raise PublicCheckpointError(
                f"Public checkpoint metadata contains {reason}"
            )


def main() -> int:
    args = parse_args()
    root = args.root.expanduser().resolve()
    try:
        included, excluded, context = select_files(root)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    created_at = datetime.now(timezone.utc).isoformat()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    checkpoint_id = f"cp_{secrets.token_hex(16)}"
    label = args.label.strip() or "agent-handoff"
    is_public = args.visibility == "public"
    if is_public and args.key_mode is not None:
        raise SystemExit(
            "Public checkpoints do not use --generate-key or --prompt-key"
        )
    key_mode = args.key_mode or "generate"
    try:
        publication = (
            public_metadata(args.public_title, args.public_description)
            if is_public
            else None
        )
    except PublicCheckpointError as error:
        raise SystemExit(str(error)) from error
    output_dir = (
        args.output_dir.expanduser()
        if args.output_dir
        else Path.home() / ".agent-checkpoints" / safe_slug(root.name)
    )
    extension = ".relay-public.tar.gz" if is_public else ".relay"
    archive_path = output_dir / f"{timestamp}-{safe_slug(label)}{extension}"
    upload_token: str | None = None
    if args.upload:
        if not args.api_url:
            raise SystemExit("Upload requires RELAY_API_URL (or --api-url).")
        try:
            upload_token = load_access_token(
                args.api_url,
                args.api_token,
                required_scope=(
                    "checkpoints:publish"
                    if is_public
                    else "checkpoints:write"
                ),
            )
        except RelayCredentialError as error:
            raise SystemExit(str(error)) from error

    handoff_text = (
        args.handoff_file.read_text(encoding="utf-8")
        if args.handoff_file
        else "Continue from this checkpoint. Inspect repository instructions and validation state before editing."
    )
    try:
        agent_metadata = resolve_agent_metadata(
            checkpoint_id=checkpoint_id,
            mode=args.agent_metadata,
            name=args.agent_name,
            description=args.agent_description,
        )
    except AgentMetadataError as error:
        raise SystemExit(str(error)) from error
    manifest = {
        "formatVersion": 2 if is_public else FORMAT_VERSION,
        "visibility": args.visibility,
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
        **({"publication": publication} if publication else {}),
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
        "visibility": args.visibility,
        "publication": publication,
        "encrypted": not is_public,
        "encryptionVersion": 0 if is_public else 2,
        "cipher": "none" if is_public else "AES-256-GCM",
        "publicFormatVersion": PUBLIC_FORMAT_VERSION if is_public else None,
        "publicFiles": [item.path for item in included] if is_public else None,
        "publicManifestMetadata": (
            {
                "formatVersion": 2,
                "visibility": "public",
                "checkpointId": checkpoint_id,
                "createdAt": None,
                "workspace": "Public workspace",
                "root": ".",
                "label": publication["title"],
                "sourceAgent": "Agent skill",
                "baseSnapshot": None,
                "treeHash": f"sha256:{context['treeHash']}",
                "stacks": [
                    str(stack)[:80]
                    for stack in context["stacks"]
                    if isinstance(stack, str)
                ][:20],
                "git": {
                    "isRepository": bool(
                        context["git"].get("isRepository")
                        if isinstance(context["git"], dict)
                        else False
                    )
                },
                "exclusions": [],
                "publication": publication,
            }
            if is_public and publication
            else None
        ),
        "keyMode": None if is_public else key_mode,
        "keyGenerated": False,
        "keyStored": False,
        "keyFile": None,
        "agent": agent_metadata,
        "agentMetadataFile": None,
        "dryRun": args.dry_run,
        "uploaded": False,
        "exclusions": [{"path": item.path, "reason": item.reason} for item in excluded],
    }
    if is_public and publication:
        try:
            validate_public_preview(
                included,
                summary["publicManifestMetadata"],
                publication,
            )
        except (OSError, ValueError, PublicCheckpointError) as error:
            raise SystemExit(str(error)) from error

    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)
        generated_key_path: Path | None = None
        try:
            checkpoint_key: bytes | None = None
            if not is_public:
                if key_mode == "generate":
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
                if is_public:
                    assert publication is not None
                    public_result = canonicalize_public_archive(
                        plaintext_path,
                        archive_path,
                        checkpoint_id=checkpoint_id,
                        title=publication["title"],
                        description=publication["description"],
                    )
                    summary["treeHash"] = public_result["treeHash"]
                    summary["includedFiles"] = public_result["includedFiles"]
                    summary["publicFiles"] = public_result["files"]
                    manifest_metadata = public_result.get(
                        "manifestMetadata",
                        summary["publicManifestMetadata"],
                    )
                    summary["publicManifestMetadata"] = manifest_metadata
                    if not args.yes:
                        print("This public checkpoint is intentionally readable.")
                        print(f"Public title: {publication['title']}")
                        print(
                            "Public description: "
                            f"{publication['description']}"
                        )
                        print("Public manifest metadata:")
                        print(
                            json.dumps(
                                manifest_metadata,
                                indent=2,
                                sort_keys=True,
                            )
                        )
                        print(
                            "Files becoming readable "
                            f"({public_result['includedFiles']}):"
                        )
                        for path in public_result["files"]:
                            print(f"  - {path}")
                        answer = input(
                            "Type 'public' to create this public artifact: "
                        )
                        if answer.strip().lower() != "public":
                            archive_path.unlink(missing_ok=True)
                            raise SystemExit("Public checkpoint creation cancelled")
                else:
                    assert checkpoint_key is not None
                    encrypt_checkpoint(
                        plaintext_path,
                        archive_path,
                        checkpoint_id,
                        checkpoint_key,
                    )
        except (
            OSError,
            PublicCheckpointError,
            RelayCryptoError,
            tarfile.TarError,
        ) as error:
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
        try:
            metadata_sidecar = save_agent_metadata(
                archive_path,
                checkpoint_id,
                agent_metadata,
            )
        except AgentMetadataError as error:
            raise SystemExit(str(error)) from error
        summary["agentMetadataFile"] = str(metadata_sidecar)
        if args.upload:
            try:
                upload_result = upload_checkpoint(
                    archive_path=archive_path,
                    api_url=args.api_url,
                    api_token=upload_token,
                    checkpoint_id=checkpoint_id,
                    checksum=summary["archiveSha256"],
                    agent_metadata=agent_metadata,
                    operation=(
                        "create-public" if is_public else "create-private"
                    ),
                    public_metadata=publication,
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
            print(
                f"Agent metadata: {agent_metadata['name']} "
                f"({agent_metadata['mode']}) — {agent_metadata['description']}"
            )
            if is_public:
                print(
                    "Public metadata: "
                    f"{publication['title']} — {publication['description']}"
                )
                print(
                    "Recovery key: not created; this public checkpoint is "
                    "intentionally readable."
                )
            elif summary["keyStored"]:
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
