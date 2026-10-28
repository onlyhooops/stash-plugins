#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SpaceCleaner - Stash external plugin operation.

Reads a JSON plugin input from stdin and prints a JSON plugin output to
stdout. It is invoked synchronously by the UI through the GraphQL
`runPluginOperation` mutation, so it never writes anything except the final
JSON result to stdout.

Supported args:
  mode      "preview" (default) or "apply"
  path      absolute directory path
  recursive bool, default true
  targets   "both" (default), "files" or "folders"
  limit     max entries returned to the UI, default 500, max 5000
"""

import json
import os
import sys
import time
import unicodedata

# Characters that should never remain at the end of a media name: Unicode
# separators (spaces, line/paragraph separators), control and format
# characters, lone surrogates from undecodable bytes, and private-use
# characters (often produced by legacy encodings, e.g. U+F028). Characters in
# the middle of a name are preserved.
TRAILING_NOISE_CATEGORIES = ("Zs", "Zl", "Zp", "Cc", "Cf", "Cs", "Co")
DEFAULT_LIMIT = 500
MAX_LIMIT = 5000

# Synology system entries: @eaDir holds thumbnails/extended attributes,
# @SynoEAStream files live inside it, and #recycle is the recycle bin. They
# are never part of a library's media names, so they are hidden from scanning
# and never renamed.
IGNORED_NAMES = ("@eadir", "@synoeastream", "#recycle")

# Renaming entries in these trees is never useful and can break the host.
BLOCKED_TREES = (
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/boot",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/usr",
    "/etc",
)


def emit(payload):
    """Write the Stash plugin output envelope as UTF-8 JSON."""
    data = json.dumps({"output": payload}, ensure_ascii=True, separators=(",", ":"))
    try:
        sys.stdout.buffer.write(data.encode("utf-8") + b"\n")
        sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError):
        pass


def fail(message):
    emit({"ok": False, "error": message})
    return 0


def rstrip_noise(name):
    """Remove trailing separators, invisible characters and private-use junk."""
    end = len(name)
    while end and unicodedata.category(name[end - 1]) in TRAILING_NOISE_CATEGORIES:
        end -= 1
    return name[:end]


def clean_folder_name(name):
    return rstrip_noise(name)


def clean_file_name(name):
    # Strip trailing junk first (e.g. "file.png  " or "file.png \uf028").
    stripped = rstrip_noise(name)
    stem, ext = os.path.splitext(stripped)
    if ext:
        # Then strip noise at the end of the stem, i.e. before the final
        # extension: "测试文件 .png" -> "测试文件.png".
        trimmed = rstrip_noise(stem)
        if not trimmed:
            return ext
        return trimmed + ext
    return stripped


def clean_name(name, kind):
    if kind == "folder":
        return clean_folder_name(name)
    return clean_file_name(name)


def is_ignored_name(name):
    return name.lower() in IGNORED_NAMES


def find_ignored_component(path):
    for part in path.split(os.sep):
        if part and is_ignored_name(part):
            return part
    return None


def as_bool(value, default):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return default


def as_int(value, default, minimum, maximum):
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def normalize_path(raw):
    if not isinstance(raw, str) or not raw.strip():
        return None, "请输入要清理的目录路径"

    path = raw
    if len(path) >= 2 and path[0] == '"' and path[-1] == '"':
        path = path[1:-1]
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        return None, "请输入绝对路径"

    path = os.path.normpath(path)
    if path == os.sep:
        return None, "不允许直接清理根目录"

    real_path = os.path.realpath(path)
    for blocked in BLOCKED_TREES:
        if real_path == blocked or real_path.startswith(blocked + os.sep):
            return None, "出于安全考虑，不允许清理系统目录：%s" % blocked

    ignored = find_ignored_component(path) or find_ignored_component(real_path)
    if ignored:
        return None, "该路径属于已屏蔽的 Synology 系统项（%s），不会扫描或重命名" % ignored

    if not os.path.isdir(real_path):
        return None, "目录不存在或不是文件夹：%s" % path

    return path, None


class Report(object):
    def __init__(self, mode, root, recursive, targets, limit):
        self.mode = mode
        self.root = root
        self.effective_root = root
        self.recursive = recursive
        self.targets = targets
        self.limit = limit
        self.scanned = 0
        self.matched = 0
        self.folders = 0
        self.files = 0
        self.pending = 0
        self.renamed = 0
        self.skipped = 0
        self.ignored = 0
        self.errors = 0
        self.entries = []
        self.truncated = False
        self.started = time.time()

    def add_entry(self, entry):
        if len(self.entries) < self.limit:
            self.entries.append(entry)
        else:
            self.truncated = True

    def add_error(self, path, message):
        self.errors += 1
        self.add_entry(
            {
                "status": "error",
                "kind": "folder",
                "old_path": path,
                "new_path": None,
                "old_name": os.path.basename(path.rstrip(os.sep)) or path,
                "new_name": None,
                "message": message,
            }
        )

    def finish(self):
        return {
            "ok": True,
            "mode": self.mode,
            "root": self.root,
            "effective_root": self.effective_root,
            "recursive": self.recursive,
            "targets": self.targets,
            "scanned": self.scanned,
            "counts": {
                "matched": self.matched,
                "folders": self.folders,
                "files": self.files,
                "pending": self.pending,
                "renamed": self.renamed,
                "skipped": self.skipped,
                "ignored": self.ignored,
                "errors": self.errors,
            },
            "entries": self.entries,
            "truncated": self.truncated,
            "duration_ms": int((time.time() - self.started) * 1000),
        }


def process_entry(report, entry_path, name, kind, is_root, apply_changes):
    """Check and optionally rename a single entry.

    Returns the path that should be used for subsequent traversal. In preview
    mode this is always the original path; after a successful rename it is the
    new path.
    """
    report.scanned += 1
    new_name = clean_name(name, kind)
    if new_name == name:
        return entry_path

    report.matched += 1
    if kind == "folder":
        report.folders += 1
    else:
        report.files += 1

    parent = os.path.dirname(entry_path)
    target = os.path.join(parent, new_name)
    entry = {
        "status": "pending",
        "kind": kind,
        "old_path": entry_path,
        "new_path": target,
        "old_name": name,
        "new_name": new_name,
        "is_root": bool(is_root),
    }

    if not new_name or new_name in (".", ".."):
        report.skipped += 1
        entry.update(
            {
                "status": "skipped",
                "reason": "empty_name",
                "reason_text": "清理后名称为空，已跳过",
            }
        )
        report.add_entry(entry)
        return entry_path

    if os.path.lexists(target):
        report.skipped += 1
        entry.update(
            {
                "status": "skipped",
                "reason": "target_exists",
                "reason_text": "同名目标已存在，已跳过（不会覆盖）",
            }
        )
        report.add_entry(entry)
        return entry_path

    if not apply_changes:
        report.pending += 1
        report.add_entry(entry)
        return entry_path

    try:
        os.rename(entry_path, target)
    except OSError as exc:
        report.errors += 1
        entry.update({"status": "error", "message": str(exc)})
        report.add_entry(entry)
        return entry_path

    report.renamed += 1
    entry.update({"status": "renamed"})
    report.add_entry(entry)
    return target


def walk_directory(report, directory, apply_changes):
    try:
        with os.scandir(directory) as iterator:
            entries = list(iterator)
    except OSError as exc:
        report.add_error(directory, "无法读取目录：%s" % exc)
        return

    files = []
    folders = []
    for entry in entries:
        if is_ignored_name(entry.name):
            # Never descend into or rename Synology system entries.
            report.ignored += 1
            continue
        try:
            is_dir = entry.is_dir(follow_symlinks=False)
        except OSError:
            is_dir = False
        if is_dir:
            folders.append(entry)
        else:
            files.append(entry)

    if report.targets in ("both", "files"):
        for entry in sorted(files, key=lambda item: item.name):
            process_entry(report, entry.path, entry.name, "file", False, apply_changes)

    for entry in sorted(folders, key=lambda item: item.name):
        current_path = entry.path
        if report.targets in ("both", "folders"):
            current_path = process_entry(
                report, entry.path, entry.name, "folder", False, apply_changes
            )
        if report.recursive:
            walk_directory(report, current_path, apply_changes)


def run(args):
    mode = str(args.get("mode") or "preview").strip().lower()
    if mode in ("scan", "dry_run", "dry-run", "preview"):
        mode = "preview"
    elif mode in ("apply", "clean", "rename"):
        mode = "apply"
    else:
        return fail("未知的操作模式：%s" % mode)

    root, error = normalize_path(args.get("path"))
    if error:
        return fail(error)

    recursive = as_bool(args.get("recursive"), True)
    targets = str(args.get("targets") or "both").strip().lower()
    if targets not in ("both", "files", "folders"):
        targets = "both"
    limit = as_int(args.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT)

    report = Report(mode, root, recursive, targets, limit)

    # The selected directory itself is also a folder name; clean it first so
    # that the rest of the traversal uses the final path.
    if targets in ("both", "folders"):
        parent, name = os.path.split(root)
        if name:
            new_root = process_entry(report, root, name, "folder", True, mode == "apply")
            if new_root != root:
                report.effective_root = new_root

    walk_directory(report, report.effective_root, mode == "apply")
    emit(report.finish())
    return 0


def main():
    try:
        raw = sys.stdin.buffer.read()
        payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
        args = payload.get("args") if isinstance(payload, dict) else None
        if not isinstance(args, dict):
            args = {}
        return run(args)
    except Exception as exc:  # noqa: BLE001 - plugin must always return JSON
        return fail("插件执行失败：%s" % exc)


if __name__ == "__main__":
    sys.exit(main())
