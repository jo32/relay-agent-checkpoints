#!/usr/bin/env python3
"""Shared, dependency-free checkpoint safety primitives."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable

FORMAT_VERSION = 1
MAX_FILE_SIZE = 100 * 1024 * 1024
TEXT_SCAN_LIMIT = 2 * 1024 * 1024

DENY_DIRS = {
    ".git": "version-control internals",
    ".hg": "version-control internals",
    ".svn": "version-control internals",
    "node_modules": "dependency tree",
    ".venv": "virtual environment",
    "venv": "virtual environment",
    "__pycache__": "language cache",
    ".pytest_cache": "test cache",
    ".mypy_cache": "type-check cache",
    ".ruff_cache": "lint cache",
    ".next": "build output",
    "dist": "build output",
    "build": "build output",
    "target": "build output",
    ".turbo": "build cache",
    ".cache": "tool cache",
    ".wrangler": "local runtime state",
    ".ssh": "credential directory",
    ".aws": "credential directory",
    ".gnupg": "credential directory",
    ".agent-checkpoint": "generated checkpoint metadata",
}

SECRET_NAMES = [
    re.compile(r"^\.env(?:\..+)?$", re.I),
    re.compile(r"^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$", re.I),
    re.compile(r"^credentials(?:\.json)?$", re.I),
    re.compile(r"^service-account.*\.json$", re.I),
    re.compile(r"^\.(?:npmrc|pypirc|netrc)$", re.I),
    re.compile(r"^secrets?\.(?:json|ya?ml|toml)$", re.I),
    re.compile(r"\.(?:pem|p12|pfx|key|keystore)$", re.I),
]

SECRET_CONTENT = [
    (re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "private key material"),
    (re.compile(rb"\bAKIA[0-9A-Z]{16}\b"), "AWS access key"),
    (re.compile(rb"\bgh[ps]_[A-Za-z0-9]{30,}\b"), "GitHub token"),
    (re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"), "API key"),
    (re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{20,}\b"), "Anthropic API key"),
    (
        re.compile(
            rb"(?:password|secret|api[_-]?key)\s*[:=]\s*[\"'][^\"'\n]{12,}[\"']",
            re.I,
        ),
        "embedded credential",
    ),
]


@dataclass(frozen=True)
class SelectedFile:
    path: str
    source: Path
    size: int
    mode: int
    sha256: str


@dataclass(frozen=True)
class ExcludedFile:
    path: str
    reason: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-")
    return slug or "checkpoint"


def git_context(root: Path) -> dict[str, object]:
    def run(*args: str) -> str | None:
        try:
            result = subprocess.run(
                ["git", "-C", str(root), *args],
                check=True,
                capture_output=True,
                text=True,
            )
            return result.stdout.strip()
        except (FileNotFoundError, subprocess.CalledProcessError):
            return None

    top = run("rev-parse", "--show-toplevel")
    if not top or Path(top).resolve() != root.resolve():
        return {"isRepository": False, "tracked": set()}

    tracked_output = run("ls-files", "-z") or ""
    tracked = {entry for entry in tracked_output.split("\0") if entry}
    status = run("status", "--short") or ""
    return {
        "isRepository": True,
        "branch": run("branch", "--show-current") or None,
        "commit": run("rev-parse", "HEAD"),
        "remote": run("config", "--get", "remote.origin.url"),
        "dirty": bool(status),
        "status": status.splitlines(),
        "tracked": tracked,
    }


def ignored_by_git(root: Path, paths: Iterable[str]) -> set[str]:
    candidates = list(paths)
    if not candidates:
        return set()
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "check-ignore", "--no-index", "--stdin", "-z"],
            input="\0".join(candidates) + "\0",
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return set()
    return {entry for entry in result.stdout.split("\0") if entry}


def infer_policy(root: Path) -> tuple[list[str], list[str]]:
    paths = {path.name for path in root.iterdir()}
    all_paths: set[str] = set()
    for current, directories, filenames in os.walk(root, topdown=True, followlinks=False):
        directories[:] = [name for name in directories if name not in DENY_DIRS]
        current_path = Path(current)
        for filename in filenames:
            all_paths.add((current_path / filename).relative_to(root).as_posix())
        if len(all_paths) > 50_000:
            break
    stacks: list[str] = []
    rules: list[str] = []

    def add(stack: str, patterns: list[str]) -> None:
        stacks.append(stack)
        rules.extend(pattern for pattern in patterns if pattern not in rules)

    if paths & {"package.json", "pnpm-lock.yaml", "yarn.lock"}:
        add("Node.js", ["node_modules/", ".next/", "dist/", "build/", ".turbo/", "*.log"])
    if paths & {"pyproject.toml", "requirements.txt", "Pipfile"}:
        add("Python", [".venv/", "venv/", "__pycache__/", ".pytest_cache/", "*.pyc"])
    if "Cargo.toml" in paths:
        add("Rust", ["target/"])
    if "go.mod" in paths:
        add("Go", ["bin/", "*.test"])
    if paths & {"pom.xml", "build.gradle", "build.gradle.kts"}:
        add("Java", ["target/", ".gradle/", "build/"])
    if any(path.endswith((".csproj", ".sln")) for path in all_paths):
        add(".NET", ["bin/", "obj/"])
    if "Gemfile" in paths:
        add("Ruby", [".bundle/", "vendor/bundle/"])
    if "composer.json" in paths:
        add("PHP", ["vendor/"])
    if "pubspec.yaml" in paths:
        add("Dart / Flutter", [".dart_tool/", "build/"])
    if "Package.swift" in paths:
        add("Swift", [".build/", "DerivedData/"])
    if any(path.endswith(".tf") for path in all_paths):
        add("Terraform", [".terraform/", "*.tfstate", "*.tfstate.*"])
    if any(path.endswith((".c", ".cc", ".cpp", ".h", ".hpp")) for path in all_paths):
        add("C / C++", ["cmake-build-*/", "CMakeFiles/", "*.o"])

    if not stacks:
        stacks.append("General project")
    for default in [".DS_Store", "Thumbs.db", "*.log", "*.tmp", "*.swp", ".cache/"]:
        if default not in rules:
            rules.append(default)
    return stacks, rules


def load_gitignore_patterns(root: Path) -> list[str]:
    patterns: list[str] = []
    for ignore_file in root.rglob(".gitignore"):
        if any(part in DENY_DIRS for part in ignore_file.relative_to(root).parts[:-1]):
            continue
        prefix = ignore_file.parent.relative_to(root).as_posix()
        if prefix == ".":
            prefix = ""
        for raw in ignore_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("!"):
                continue
            line = line.lstrip("/")
            patterns.append(f"{prefix}/{line}".lstrip("/"))
    return patterns


def simple_ignored(path: str, patterns: Iterable[str]) -> bool:
    pure = PurePosixPath(path)
    for raw in patterns:
        pattern = raw.rstrip("/")
        if not pattern:
            continue
        if "/" not in pattern and pattern in pure.parts:
            return True
        if fnmatch.fnmatch(path, pattern) or pure.match(pattern):
            return True
        if path == pattern or path.startswith(pattern + "/"):
            return True
    return False


def mandatory_reason(path: str, source: Path, info: os.stat_result) -> str | None:
    parts = PurePosixPath(path).parts
    for part in parts[:-1]:
        if part in DENY_DIRS:
            return DENY_DIRS[part]
    name = parts[-1]
    if name in {".DS_Store", "Thumbs.db"} or name.endswith(("~", ".swp", ".tmp")):
        return "temporary file"
    if name != ".env.example" and any(pattern.search(name) for pattern in SECRET_NAMES):
        return "credential or secret file"
    if stat.S_ISLNK(info.st_mode):
        return "unsafe symbolic link"
    if not stat.S_ISREG(info.st_mode):
        return "special file"
    if info.st_size > MAX_FILE_SIZE:
        return "file exceeds 100 MB safety limit"
    return None


def secret_reason(source: Path, size: int) -> str | None:
    if size > TEXT_SCAN_LIMIT:
        return None
    try:
        data = source.read_bytes()
    except OSError:
        return "unreadable file"
    if b"\0" in data[:4096]:
        return None
    for pattern, reason in SECRET_CONTENT:
        if pattern.search(data):
            return reason
    return None


def select_files(root: Path) -> tuple[list[SelectedFile], list[ExcludedFile], dict[str, object]]:
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"Project root is not a directory: {root}")

    git = git_context(root)
    tracked = set(git.pop("tracked", set()))
    stacks, inferred = infer_policy(root)
    has_root_gitignore = (root / ".gitignore").is_file()
    fallback_patterns = load_gitignore_patterns(root) if has_root_gitignore else inferred

    all_entries: list[tuple[str, Path, os.stat_result]] = []
    pruned: list[ExcludedFile] = []
    for current, directories, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        rel_dir = current_path.relative_to(root)
        kept_directories: list[str] = []
        for directory in directories:
            rel = (rel_dir / directory).as_posix()
            source = current_path / directory
            info = source.lstat()
            reason = DENY_DIRS.get(directory)
            if reason:
                pruned.append(ExcludedFile(rel + "/", reason))
                continue
            if stat.S_ISLNK(info.st_mode):
                pruned.append(ExcludedFile(rel + "/", "unsafe symbolic link"))
                continue
            kept_directories.append(directory)
        directories[:] = kept_directories
        for filename in filenames:
            source = current_path / filename
            rel = source.relative_to(root).as_posix()
            try:
                info = source.lstat()
            except OSError:
                continue
            all_entries.append((rel, source, info))

    ignored = (
        ignored_by_git(root, (path for path, _, _ in all_entries))
        if git.get("isRepository")
        else set()
    )
    included: list[SelectedFile] = []
    excluded: list[ExcludedFile] = list(pruned)

    for path, source, info in all_entries:
        is_tracked = path in tracked
        reason = mandatory_reason(path, source, info)
        if is_tracked and reason == "temporary file":
            reason = None
        if reason:
            excluded.append(ExcludedFile(path, reason))
            continue
        if not is_tracked and (path in ignored or simple_ignored(path, fallback_patterns)):
            excluded.append(
                ExcludedFile(
                    path,
                    ".gitignore rule" if has_root_gitignore else "inferred project rule",
                )
            )
            continue
        reason = secret_reason(source, info.st_size)
        if reason:
            excluded.append(ExcludedFile(path, reason))
            continue
        included.append(
            SelectedFile(
                path=path,
                source=source,
                size=info.st_size,
                mode=stat.S_IMODE(info.st_mode) & 0o777,
                sha256=sha256_file(source),
            )
        )

    included.sort(key=lambda item: item.path)
    excluded.sort(key=lambda item: item.path)
    tree_material = "".join(f"{item.path}\0{item.sha256}\n" for item in included).encode()
    context = {
        "git": git,
        "stacks": stacks,
        "inferredRules": inferred,
        "hasRootGitignore": has_root_gitignore,
        "treeHash": sha256_bytes(tree_material),
    }
    return included, excluded, context


def validate_member_name(name: str) -> str:
    if not name or "\0" in name:
        raise ValueError("Archive contains an empty or invalid member name")
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts:
        raise ValueError(f"Archive member escapes the destination: {name}")
    normalized = pure.as_posix()
    if normalized.startswith("../") or normalized == "..":
        raise ValueError(f"Archive member escapes the destination: {name}")
    return normalized


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
