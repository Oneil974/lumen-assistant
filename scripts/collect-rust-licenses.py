#!/usr/bin/env python3
"""Collect desktop Cargo metadata and standalone license texts after cargo fetch."""
import json
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
data = json.loads(subprocess.check_output([
    os.environ.get("CARGO", "cargo"), "metadata", "--format-version", "1", "--locked",
    "--offline", "--manifest-path", str(root / "src-tauri/Cargo.toml")], cwd=root))
out = root / "src/legal/rust"
out.mkdir(parents=True, exist_ok=True)
inventory = []
for pkg in sorted(data["packages"], key=lambda p: (p["name"], p["version"])):
    directory = Path(pkg["manifest_path"]).parent
    candidates = [p for p in directory.iterdir() if p.is_file() and re.match(r"^(licen[cs]e|copying|notice|copyright)([._-]|$)", p.name, re.I)]
    if pkg.get("license_file"):
        path = directory / pkg["license_file"]
        if path.is_file() and path not in candidates:
            candidates.append(path)
    texts = []
    for path in sorted(candidates):
        name = f"{pkg['name']}--{pkg['version']}--{path.name}.txt"
        (out / name).write_bytes(path.read_bytes())
        texts.append(name)
    inventory.append({"name": pkg["name"], "version": pkg["version"], "license": pkg.get("license"),
                      "source": pkg.get("repository"), "files": texts})
(out / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
print(f"{len(inventory)} Cargo packages inventoried; {sum(not p['files'] for p in inventory)} without a standalone root license file")
