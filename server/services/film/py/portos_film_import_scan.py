"""Classify a film's import closure without executing it.

Prints ``blender`` when ``film.py`` or a local module it imports names
``bpy``, ``bmesh`` or ``mathutils``, including an import nested in a function
or a branch. Prints ``python`` otherwise. A file that cannot be parsed, or a
path that leaves ``src/``, counts as ``blender``: the absence of those modules
was not shown. ``portos_film`` is the shipped helper kit and is not followed.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

HOST = {"bpy", "bmesh", "mathutils"}
MAX_FILES = 500


def _inside(src: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(src.resolve())
    except (OSError, ValueError):
        return False
    return True


def _local_file(src: Path, parts: list[str]) -> str | None:
    if not parts or any(part in ("", ".", "..") for part in parts):
        return None
    relative = Path(*parts)
    for suffix in (Path(f"{relative}.py"), relative / "__init__.py"):
        candidate = src / suffix
        try:
            if not candidate.is_file():
                continue
        except OSError:
            return "escape"
        if not _inside(src, candidate):
            return "escape"
        return suffix.as_posix()
    return None


def _imported(current_rel: str, tree: ast.AST) -> list[list[str]]:
    directory = current_rel.split("/")[:-1]
    found: list[list[str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.append([part for part in alias.name.split(".") if part])
            continue
        if not isinstance(node, ast.ImportFrom):
            continue
        base = [part for part in (node.module or "").split(".") if part]
        parents = list(directory)
        for _step in range(max(0, (node.level or 0) - 1)):
            if parents:
                parents.pop()
        root = (parents if node.level else []) + base
        found.append(list(root))
        for alias in node.names:
            if alias.name and alias.name != "*" and alias.name.isidentifier():
                found.append([*root, alias.name])
    return found


def needs_blender(src: Path) -> bool:
    pending = ["film.py"]
    seen: set[str] = set()
    while pending:
        relative = pending.pop()
        if relative in seen:
            continue
        seen.add(relative)
        if len(seen) > MAX_FILES:
            return True
        path = src.joinpath(*relative.split("/"))
        if not _inside(src, path):
            return True
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=relative)
        except (OSError, SyntaxError, UnicodeError, ValueError):
            return True
        for parts in _imported(relative, tree):
            if not parts or parts[0] == "portos_film":
                continue
            if parts[0] in HOST:
                return True
            for length in range(1, len(parts) + 1):
                follow = _local_file(src, parts[:length])
                if follow == "escape":
                    return True
                if follow and follow not in seen:
                    pending.append(follow)
    return False


def main() -> int:
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if folder is None or not (folder / "film.py").is_file():
        sys.stdout.write("blender\n")
        return 0
    sys.stdout.write("blender\n" if needs_blender(folder) else "python\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
