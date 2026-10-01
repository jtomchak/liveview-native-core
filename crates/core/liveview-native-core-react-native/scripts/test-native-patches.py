#!/usr/bin/env python3
"""Run the actual Swift native patch encoder/session with small platform stubs.

Requires Swift/Foundation (the same Xcode toolchain used for simulator builds).
No generated Rust bindings, Expo dependency, or running device is required.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile

PACKAGE = Path(__file__).resolve().parents[1]
SOURCE = PACKAGE / "ios" / "LiveViewNativeModule.swift"


def section(source: str, start: str, end: str) -> str:
    return source[source.index(start):source.index(end, source.index(start))]


def main() -> None:
    swift = shutil.which("swift")
    if swift is None:
        raise SystemExit("Swift toolchain required; install/configure Xcode before running native patch checks")
    source = SOURCE.read_text()
    record = section(source, "fileprivate struct LiveViewNativeUpdate", "\n@ExpoModule")
    native_session = section(source, "private final class NativeSession:", "\n// Pure encoder:")
    encoder = section(source, "private struct NormalizedSnapshot {", "\nprivate func nativeJSON(")
    fixture_dir = PACKAGE / "tests" / "native"
    with tempfile.TemporaryDirectory(prefix="lvn-native-patch-check-") as temporary:
        for name, production in [
            ("PatchEncoderChecks.swift", encoder),
            ("PatchSessionChecks.swift", record + "\n" + native_session + "\n" + encoder),
        ]:
            path = Path(temporary) / name
            path.write_text("import Foundation\n" + production + "\n" + (fixture_dir / name).read_text())
            subprocess.run([swift, str(path)], check=True)


if __name__ == "__main__":
    main()
