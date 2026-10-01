import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import sys
import subprocess

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("build_utils", Path(__file__).with_name("build-utils.py"))
utils = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utils)


class BuildUtilsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "source"
        self.target = self.directory / "target"
        self.source.mkdir()
        (self.source / "binding.swift").write_text("generated binding")

    def test_identical_regeneration_preserves_existing_mtime(self):
        utils.sync_tree(self.source, self.target)
        binding = self.target / "binding.swift"
        os.utime(binding, ns=(1_000_000_000, 1_000_000_000))
        (self.source / "binding.swift").write_text("generated binding")
        utils.sync_tree(self.source, self.target)
        self.assertEqual(binding.stat().st_mtime_ns, 1_000_000_000)

    def test_changed_and_missing_files_are_updated_and_stale_files_removed(self):
        utils.sync_tree(self.source, self.target)
        (self.target / "binding.swift").write_text("outdated binding!")
        (self.target / "stale.kt").write_text("obsolete")
        (self.source / "subdirectory").mkdir()
        (self.source / "subdirectory" / "header.h").write_text("new header")
        utils.sync_tree(self.source, self.target)
        self.assertEqual((self.target / "binding.swift").read_text(), "generated binding")
        self.assertEqual((self.target / "subdirectory" / "header.h").read_text(), "new header")
        self.assertFalse((self.target / "stale.kt").exists())
        (self.target / "binding.swift").unlink()
        utils.sync_tree(self.source, self.target)
        self.assertEqual((self.target / "binding.swift").read_text(), "generated binding")

    def test_sync_does_not_follow_existing_destination_symlink(self):
        outside = self.directory / "outside"
        outside.write_text("leave this intact")
        self.target.mkdir()
        (self.target / "binding.swift").symlink_to(outside)
        utils.sync_tree(self.source, self.target)
        self.assertEqual(outside.read_text(), "leave this intact")
        self.assertFalse((self.target / "binding.swift").is_symlink())

    def test_file_sync_cli_rejects_directory_destination_without_removing_contents(self):
        self.target.mkdir()
        existing = self.target / "library.so"
        existing.write_text("installed library")
        result = subprocess.run([
            sys.executable, str(Path(__file__).with_name("build-utils.py")),
            "sync-file", str(self.source / "binding.swift"), str(self.target)
        ], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("destination must include a filename", result.stderr)
        self.assertEqual(existing.read_text(), "installed library")

    def test_package_key_uses_compiled_content_and_profile_not_mtime(self):
        library = self.source / "binding.swift"
        original = utils.input_key("dev", [library])
        os.utime(library, ns=(1, 1))
        self.assertEqual(utils.input_key("dev", [library]), original)
        self.assertNotEqual(utils.input_key("release", [library]), original)
        library.write_text("compiled library changed")
        self.assertNotEqual(utils.input_key("dev", [library]), original)

    def test_package_reuse_requires_matching_key_and_complete_unchanged_artifact(self):
        state = self.directory / "package.json"
        utils.sync_tree(self.source, self.target)
        utils.record_package(state, "inputs", self.target)
        self.assertTrue(utils.package_valid(state, "inputs", self.target))
        self.assertFalse(utils.package_valid(state, "different inputs", self.target))
        original = state.stat().st_mtime_ns
        utils.record_package(state, "inputs", self.target)
        self.assertEqual(state.stat().st_mtime_ns, original)
        binding = self.target / "binding.swift"
        binding.write_text("corrupt packaged library")
        self.assertFalse(utils.package_valid(state, "inputs", self.target))
        utils.sync_tree(self.source, self.target)
        self.assertTrue(utils.package_valid(state, "inputs", self.target))
        binding.unlink()
        self.assertFalse(utils.package_valid(state, "inputs", self.target))
        state.write_text("invalid json")
        self.assertFalse(utils.package_valid(state, "inputs", self.target))


if __name__ == "__main__":
    unittest.main()
