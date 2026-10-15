"""Safety and repeat-sync behavior of the public mirror."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("export_source", Path(__file__).with_name("export-source.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.original = module.ROOT
        self.addCleanup(setattr, module, "ROOT", self.original)
        module.ROOT = Path(self.tmp.name) / "source"
        module.ROOT.mkdir()
        self.root = module.ROOT
        (self.root / "tools/synchub").mkdir(parents=True)
        (self.root / "tools/synchub/targets.example.json").write_text('{"repo":".","targets":[]}')
        (self.root / ".gitignore").write_text("dist/\n")
        (self.root / "src").mkdir()
        (self.root / "src/main.js").write_text("export const ready = true;\n")
        self.out = Path(self.tmp.name) / "public"

    def test_dry_then_repeat_removes_stale_preserves_git_and_foreign_files(self):
        module.export(self.out, dry=True)
        self.assertFalse(self.out.exists())
        module.export(self.out)
        (self.out / ".git").mkdir()
        (self.out / ".git/HEAD").write_text("ref: refs/heads/main")
        (self.out / "personal.txt").write_text("keep")
        (self.out / "src/._main.js").write_text("generated metadata")
        (self.root / "src/main.js").unlink()
        result = module.export(self.out)
        self.assertIn("src/main.js", result["removed"])
        self.assertEqual((self.out / "personal.txt").read_text(), "keep")
        self.assertTrue((self.out / ".git/HEAD").exists())
        self.assertFalse((self.out / "src/._main.js").exists())
        self.assertEqual(module.export(self.out)["changed"], [])

    def test_refuses_unmanaged_folder_or_edited_file(self):
        self.out.mkdir()
        (self.out / "keep").write_text("important")
        with self.assertRaises(ValueError):
            module.export(self.out)
        (self.out / "keep").unlink()
        module.export(self.out)
        (self.out / "src/main.js").write_text("local work")
        with self.assertRaises(ValueError):
            module.export(self.out)
        self.assertEqual((self.out / "src/main.js").read_text(), "local work")

    def test_excludes_private_data_and_keeps_portable_configuration(self):
        for rel in ["src-tauri/.cargo/config.toml", "tools/synchub-app/src-tauri/.cargo/config.toml", "lumen-controller/config_local.py", "m5fire-orb/mic_input.wav", "docs/assets/demo.mov", "tools/synchub/targets.json", "src/user.db", "src/.env", "src-tauri/resources/llama-server/macos-arm64/server"]:
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("private")
        (self.root / "src-tauri/resources/llama-server/README.md").write_text("Build this runtime from source")
        module.export(self.out)
        self.assertFalse((self.out / "src-tauri/.cargo/config.toml").exists())
        self.assertFalse((self.out / "tools/synchub-app/src-tauri/.cargo/config.toml").exists())
        self.assertFalse((self.out / "lumen-controller/config_local.py").exists())
        self.assertFalse((self.out / "m5fire-orb/mic_input.wav").exists())
        self.assertFalse((self.out / "docs/assets/demo.mov").exists())
        self.assertFalse((self.out / "src/user.db").exists())
        self.assertTrue((self.out / "src-tauri/resources/llama-server/README.md").exists())
        self.assertFalse((self.out / "src-tauri/resources/llama-server/macos-arm64").exists())
        self.assertEqual(json.loads((self.out / "tools/synchub/targets.json").read_text())["targets"], [])
        self.assertNotIn("/Volumes", (self.out / "dev.sh").read_text())

    def test_symlink_and_manifest_traversal_are_refused(self):
        (self.root / "src/link").symlink_to(self.root / ".gitignore")
        with self.assertRaises(ValueError):
            module.export(self.out)
        (self.root / "src/link").unlink()
        module.export(self.out)
        marker = self.out / module.MARKER
        marker.write_text(json.dumps({"format": 1, "files": {"../outside": "hash"}}))
        with self.assertRaises(ValueError):
            module.export(self.out)

    def test_credentials_stop_export_without_printing_value(self):
        credentials = ["ghp_" + "A" * 36, "hf_" + "a" * 30,
                       "sk-proj-" + "a" * 30, "xoxb-" + "a" * 25,
                       "AIza" + "a" * 35, "npm_" + "a" * 36,
                       "123456789:" + "a" * 35]
        for credential in credentials:
            with self.subTest(provider=credential.split("_")[0][:5]):
                (self.root / "src/main.js").write_text(credential)
                with self.assertRaises(ValueError) as error:
                    module.export(self.out)
                self.assertNotIn(credential, str(error.exception))
                self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
