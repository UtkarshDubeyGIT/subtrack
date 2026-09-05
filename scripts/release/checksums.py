"""Write checksums for installer artifacts without including intermediate app files."""
import hashlib
from pathlib import Path
import sys

bundle = Path(sys.argv[1])
installers = sorted(p for p in bundle.rglob("*") if p.suffix in {".dmg", ".exe"})
if not installers:
    raise SystemExit("No installers were produced.")
lines = []
for installer in installers:
    with installer.open("rb") as source:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
        digest = checksum.hexdigest()
    lines.append(f"{digest}  {installer.relative_to(bundle).as_posix()}")
(bundle / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"Checksums recorded for {len(installers)} installer(s).")
