#!/usr/bin/env python3
"""Prepare a managed source mirror; never copy workstation config or build caches."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MARKER = ".lumen-source-export.json"
ROOTS = ["src", "src-tauri", "scripts", "config", "docs", ".github", "tools",
         "ios-companion", "lumen-controller",
         "esp32-orb", "hardware", "package.json", "package-lock.json",
         "rust-toolchain.toml", "README.md", "README.fr.md", "BUILDING.md", "LICENSE.md", "COPYING", "NOTICE",
         "THIRD_PARTY_NOTICES.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]
SKIP_PARTS = {".git", "node_modules", "target", "gen", "dist", "build", "builds",
              "__pycache__", ".venv", "venv", "models", "outputs", ".DS_Store",
              ".pytest_cache", "DerivedData", "xcuserdata", "reports"}
SKIP_PATHS = {"src-tauri/.cargo/config.toml", "tools/synchub/targets.json",
              "scripts/test-m5-agent-sprites.py", "scripts/sync-pc.sh", "scripts/slice-packs.mjs", "scripts/pack-kaykit.mjs"}
SKIP_PREFIXES = ("docs/audits/", "src/village/assets/packs/", "src/lib/avatars/metrocity/",
                 "tools/synchub/", "tools/synchub-app/", "lumen-server/", "lumen-robotd/", "m5fire-orb/", "hardware/pi-case/", "scripts/orch-eval/report-")
SECRET_NAME = re.compile(r"(?:^\.env(?:\.|$)|\.(?:pem|p12|pfx|p8|key|keystore|db|sqlite|sqlite3|gguf|sparseimage)$|^id_(?:rsa|ed25519)$)", re.I)
SECRET_CONTENT = re.compile(
    rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{32,}"
    rb"|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{50,}"
    rb"|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"
    rb"|\bsk-(?:proj-|ant-api[0-9]+-)?[A-Za-z0-9_-]{20,}"
    rb"|\b(?:sk|rk)_live_[A-Za-z0-9]{20,}"
    rb"|\bxox[baprs]-[A-Za-z0-9-]{15,}|\bhf_[A-Za-z0-9]{25,}"
    rb"|\bAIza[A-Za-z0-9_-]{30,}|\bnpm_[A-Za-z0-9]{30,}"
    rb"|\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b"
)



def excluded(rel: str, directory: bool = False) -> bool:
    parts = Path(rel).parts
    if any(p in SKIP_PARTS or p.startswith(("._", "__preview")) for p in parts):
        return True
    if rel == "m5fire-orb/mic_input.wav" or (rel.startswith("docs/assets/") and rel.lower().endswith(".mov")):
        return True
    if rel in SKIP_PATHS or rel.endswith("/.cargo/config.toml") or parts[-1] in {"config_local.py", ".netrc", ".npmrc", ".pypirc", "credentials.json"} or (rel + "/" if directory else rel).startswith(SKIP_PREFIXES) or SECRET_NAME.search(parts[-1]):
        return True
    if rel.endswith((".log", ".pyc", ".dmg", ".deb", ".AppImage", ".exe", ".zip", ".tar.gz")):
        # Keep the Python standard library shipped with Pyodide.
        return rel != "src/python/vendor/pyodide/python_stdlib.zip"
    if rel.startswith("src-tauri/resources/"):
        if directory:
            return len(parts) > 3
        return len(parts) > 4 or (len(parts) == 4 and parts[-1] not in {"README.md", "README.txt"})
    return False


def generated() -> dict[str, bytes]:
    return {
        "dev.sh": b'#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\nexec npm run tauri dev -- "$@"\n',
        ".gitignore": (ROOT / ".gitignore").read_bytes() + b"\n" + MARKER.encode() + b"\n# Private projects and workstation credentials\n/tools/synchub/\n/tools/synchub-app/\n/lumen-server/\n/lumen-robotd/\n/m5fire-orb/\n/hardware/pi-case/\n**/config_local.py\n**/.cargo/config.toml\n",
        "src/village/assets/packs/manifest.json": b"[]\n",
        # Keep the optional asset directory so the shared dependency graph can
        # package it, without redistributing artwork with unverified rights.
        "src/lib/avatars/metrocity/README.md": b"# Optional artwork omitted\n\nMetroCity artwork is not included in this source distribution.\nChoose an available Kenney avatar in this source distribution.\n",
    }


def sanitize_config(rel: str, data: bytes) -> bytes:
    """Never export workstation Wi-Fi settings, including tuple/list forms."""
    if not rel.endswith("/config.py"):
        return data
    try:
        tree = ast.parse(data.decode("utf-8-sig"))
    except (SyntaxError, UnicodeDecodeError):
        return data
    replacements = {"WIFI_ENABLE": "False", "WIFI_SSID": '"CHANGE_ME"',
                    "WIFI_PASS": '"CHANGE_ME"', "WIFI_PASSWORD": '"CHANGE_ME"',
                    "WIFI_NETWORKS": "[]"}
    lines = data.decode("utf-8-sig").splitlines(keepends=True)
    edits = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in replacements:
                edits.append((node.lineno - 1, node.end_lineno, f"{name} = {replacements[name]}\n"))
    for start, end, replacement in reversed(edits):
        lines[start:end] = [replacement]
    return "".join(lines).encode()


def check_python_credentials(rel: str, data: bytes) -> None:
    if not rel.endswith(".py"):
        return
    try:
        tree = ast.parse(data.decode("utf-8-sig"))
    except (SyntaxError, UnicodeDecodeError):
        return
    names = {"WIFI_SSID", "WIFI_PASS", "WIFI_PASSWORD", "WIFI_NETWORKS", "API_KEY", "BOT_TOKEN", "ACCESS_TOKEN", "CLIENT_SECRET"}
    def configured(value):
        if isinstance(value, str):
            return bool(value) and value != "CHANGE_ME" and not value.startswith(("YOUR_", "VOTRE_"))
        if isinstance(value, dict):
            return any(configured(v) for v in value.values())
        if isinstance(value, (list, tuple)):
            return any(configured(v) for v in value)
        return False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or not any(isinstance(t, ast.Name) and t.id.upper() in names for t in node.targets):
            continue
        try:
            value = ast.literal_eval(node.value)
        except (ValueError, TypeError):
            continue
        if configured(value):
            raise ValueError(f"Configured credentials in {rel}:{node.lineno}; export stopped (value hidden)")


def plan(source: Path | None = None) -> dict[str, bytes]:
    source = source or ROOT
    files: dict[str, bytes] = {}
    for name in ROOTS:
        base = source / name
        if not base.exists():
            continue
        if base.is_symlink():
            raise ValueError(f"Source symlink refused: {name}")
        if base.is_file():
            paths = [base]
        else:
            paths = []
            for directory, dirs, names in os.walk(base, followlinks=False):
                parent = Path(directory)
                for d in list(dirs):
                    p = parent / d
                    rel = p.relative_to(source).as_posix()
                    if excluded(rel, directory=True):
                        dirs.remove(d)
                    elif p.is_symlink():
                        raise ValueError(f"Source symlink refused: {rel}")
                paths.extend(parent / n for n in names)
        for p in paths:
            rel = p.relative_to(source).as_posix()
            if excluded(rel):
                continue
            if p.is_symlink():
                raise ValueError(f"Source symlink refused: {rel}")
            data = sanitize_config(rel, p.read_bytes())
            check_python_credentials(rel, data)
            if rel == "package.json":
                package = json.loads(data)
                for private_tool in ("synchub", "build:server"):
                    package.get("scripts", {}).pop(private_tool, None)
                data = (json.dumps(package, indent=2, ensure_ascii=False) + "\n").encode()
            if rel == "scripts/build-all.sh":
                data = data.replace(b"TARGETS=(lumen server)", b"TARGETS=(lumen)").replace(b"aucune = les deux", b"aucune = lumen")
            if SECRET_CONTENT.search(data):
                raise ValueError(f"Possible credential in {rel}; export stopped (value hidden)")
            # A historical application ID only locates a developer cache.
            # Keep that fallback locally; omit it from the portable script.
            if rel == "scripts/build-bonsai-engine.sh":
                data = b"".join(line for line in data.splitlines(keepends=True) if b"com.mickaelhoarau.lumen" not in line)
            files[rel] = data
    files.update(generated())
    return files


def safe_path(root: Path, rel: str) -> Path:
    p = Path(rel)
    if p.is_absolute() or ".." in p.parts or not p.parts or p.parts[0] == ".git":
        raise ValueError(f"Unsafe managed path: {rel}")
    target = root / p
    for part in [target, *target.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f"Destination symlink refused: {rel}")
    return target


def export(out: Path, dry: bool = False) -> dict:
    if out.is_symlink():
        raise ValueError("Destination symlink refused")
    out = out.resolve()
    if out == ROOT or out in ROOT.parents or any((ROOT / p).resolve() == out or (ROOT / p).resolve() in out.parents for p in ROOTS):
        raise ValueError("Destination must be outside maintained source directories")
    marker = out / MARKER
    if marker.is_symlink():
        raise ValueError("Export marker symlink refused")
    previous = {}
    if marker.exists():
        old = json.loads(marker.read_text())
        if old.get("format") != 1:
            raise ValueError("Unknown export manifest format")
        previous = old["files"]
    elif out.exists() and any(out.iterdir()):
        raise ValueError("Destination is not empty and is not a managed Lumen export")
    files = plan()
    hashes = {p: hashlib.sha256(data).hexdigest() for p, data in files.items()}
    # Validate every path before making any change. Preserve unrelated files and .git.
    for rel in set(files) | set(previous):
        target = safe_path(out, rel)
        if target.exists() and rel in previous and hashlib.sha256(target.read_bytes()).hexdigest() != previous[rel]:
            raise ValueError(f"Export has local changes: {rel}; move them to the source before synchronising")
        if target.exists() and rel not in previous:
            raise ValueError(f"Unmanaged destination file: {rel}")
    changed = sorted(p for p, h in hashes.items() if previous.get(p) != h or not (out / p).exists())
    removed = sorted(set(previous) - set(files))
    result = {"destination": str(out), "dry": dry, "files": len(files), "bytes": sum(map(len, files.values())),
              "changed": changed, "removed": removed,
              "notes": ["Local APFS settings and Sync Hub targets excluded", "Unverified Gaming/Cosy and MetroCity artwork excluded", "No commit, push or publication performed"]}
    if dry:
        return result
    out.mkdir(parents=True, exist_ok=True)
    for rel in changed:
        target = safe_path(out, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".export-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(files[rel])
            os.chmod(tmp, 0o755 if rel.endswith((".sh", ".py")) or rel == "scripts/pigpio-lite/pigs" else 0o644)
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    for rel in removed:
        safe_path(out, rel).unlink(missing_ok=True)
    marker.write_text(json.dumps({"format": 1, "files": hashes}, indent=2) + "\n")
    # macOS may generate AppleDouble files while writing onto exFAT. Tauri
    # treats ._default.json as a capability file, so clean generated metadata
    # after the copy as well as excluding it from the source selection.
    directories = {out}
    for rel in files:
        parent = safe_path(out, rel).parent
        while parent != out:
            directories.add(parent)
            parent = parent.parent
    for directory in directories:
        if directory.exists():
            for item in directory.iterdir():
                if item.is_file() and (item.name.startswith("._") or item.name == ".DS_Store"):
                    item.unlink()
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "public-source")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(export(args.out, args.dry_run), indent=2, ensure_ascii=False))
    except (ValueError, OSError) as error:
        parser.exit(1, f"Export refused: {error}\n")
