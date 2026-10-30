#!/usr/bin/env python3
"""Install the private WebClient rescue as Chrome DevTools Local Overrides.

Python 3.9+; standard library only. Double-click this file after saving the
website's payload ZIP beside it. The script creates ./overrides beside itself,
installs all 86 bundled files, and fetches only the 101 MB wasm separately from
the Internet Archive. The website embeds your selected public place ID into
this script when you download it. No PowerShell or command-line flags required.
No Websim password, bearer token, or Roblox credential is used or stored here.
DevTools and Tampermonkey still need one-time manual setup.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import zipfile

# Filled from the returned project ID and integer revision number, not a UUID.
SITE_BASE = "https://websim.com/p/i4lk0cnup017dg1cig3o/1"
# Website replaces this numeric placeholder in the downloaded setup.py.
# The uncustomized source can also ask for a place ID in a small dialog.
DEFAULT_PLACE_ID = "URPLACEID"
# Filled by tools/build_payload.py; never bypass these integrity checks.
BUNDLE_SHA256 = "a495e985e35813f4c7480558a9f5ead0685dedba3765c026ec464772ccb2e962"
BUNDLE_SIZE = 18688036
PARTS = [{'name': 'payload.part1', 'size': 6500000, 'sha256': 'aa69a08b02d854632775c661314bf0c09e507e4baf4b5bc46bbe9a60b2d8ea9c'}, {'name': 'payload.part2', 'size': 6500000, 'sha256': '6063d72b6a0f166b27a0880dc4f68a93a5ceb34a03c9082eac7155565d4a9a61'}, {'name': 'payload.part3', 'size': 5688036, 'sha256': 'f48af9da3f8418fff92b2c472617d38646e5f4f261ba68f40cb97aaec9562fdd'}]
USER_AGENT = "RelayClient/1.0"
ENGINE_VERSION = "version-f4a4dba57f874ad0-RobloxWebClient"
BROWSER_BUNDLE_NAME = "webclient-rescue-payload.zip"
BLOCK = 1024 * 1024


class InstallError(Exception):
    """Safe, actionable installer error."""


def log(message: str) -> None:
    print(message, flush=True)


def safe_rel(name: str) -> Path:
    if not isinstance(name, str) or not name or name.startswith(("/", "\\")):
        raise InstallError("Unsafe empty/absolute path in a package")
    name = name.replace("\\", "/")
    if re.match(r"^[A-Za-z]:", name):
        raise InstallError("Unsafe drive path in a package")
    p = PurePosixPath(name)
    if not p.parts or any(bit in ("", ".", "..") for bit in name.split("/")):
        raise InstallError("Unsafe traversal path in a package")
    return Path(*p.parts)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(BLOCK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def verified(path: Path, size: int, sha256: str) -> bool:
    return path.is_file() and path.stat().st_size == size and file_sha256(path) == sha256


def atomic_bytes(destination: Path, data: bytes) -> bool:
    if destination.is_file() and destination.stat().st_size == len(data):
        if hashlib.sha256(destination.read_bytes()).digest() == hashlib.sha256(data).digest():
            return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_name(destination.name + ".installing")
    try:
        with tmp.open("wb") as out:
            out.write(data)
        tmp.replace(destination)
    finally:
        if tmp.exists():
            tmp.unlink()
    return True


def copy_verified(source: Path, destination: Path, size: int, sha256: str) -> None:
    if not verified(source, size, sha256):
        raise InstallError("Wasm source failed SHA-256/size check; no file installed")
    if verified(destination, size, sha256):
        log("  WebClient.wasm already correct")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_name(destination.name + ".installing")
    try:
        with source.open("rb") as input_file, tmp.open("wb") as output_file:
            shutil.copyfileobj(input_file, output_file, length=BLOCK)
        if not verified(tmp, size, sha256):
            raise InstallError("Copied wasm failed SHA-256 check")
        tmp.replace(destination)
    finally:
        if tmp.exists():
            tmp.unlink()
    log("  WebClient.wasm installed and verified")


def download_checked(url: str, dest: Path, size: int, sha256: str, label: str) -> Path:
    """Download with Range resume and atomic SHA-256 verification."""
    if verified(dest, size, sha256):
        log("  " + label + ": cached")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    if verified(part, size, sha256):
        part.replace(dest)
        return dest
    if part.is_file() and part.stat().st_size > size:
        part.unlink()
    failure = ""
    for attempt in range(1, 5):
        start = part.stat().st_size if part.is_file() else 0
        if start == size and not verified(part, size, sha256):
            part.unlink()
            start = 0
        headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
        if start:
            headers["Range"] = "bytes=" + str(start) + "-"
        try:
            with urlopen(Request(url, headers=headers), timeout=90) as response:
                kind = response.headers.get("Content-Type", "").lower()
                if "text/html" in kind:
                    raise InstallError(label + ": got a browser login page, not file bytes")
                if response.status == 206:
                    content_range = response.headers.get("Content-Range", "")
                    if not content_range.startswith("bytes " + str(start) + "-"):
                        raise InstallError(label + ": invalid Range response")
                elif response.status == 200:
                    start = 0  # server ignored Range: restart instead of corrupting a partial file
                else:
                    raise InstallError(label + ": unexpected HTTP " + str(response.status))
                done = start
                next_mark = (done // (10 * BLOCK) + 1) * (10 * BLOCK)
                with part.open("ab" if start else "wb") as out:
                    while True:
                        block = response.read(BLOCK)
                        if not block:
                            break
                        done += len(block)
                        if done > size:
                            raise InstallError(label + ": larger than the pinned file size")
                        out.write(block)
                        if size > 20 * BLOCK and done >= next_mark:
                            log("  " + label + ": " + str(done // BLOCK) + "/" + str(size // BLOCK) + " MiB")
                            next_mark += 10 * BLOCK
            if verified(part, size, sha256):
                part.replace(dest)
                log("  " + label + ": SHA-256 OK")
                return dest
            if part.stat().st_size == size:
                part.unlink()
                raise InstallError(label + ": checksum mismatch")
            failure = label + ": interrupted download; resuming"
            log("  " + failure)
        except HTTPError as err:
            failure = label + ": HTTP " + str(err.code)
            if err.code in (401, 403, 404):
                raise InstallError(failure) from err
            if err.code == 429:
                wait = err.headers.get("Retry-After", "")
                delay = int(wait) if wait.isdecimal() else 3 * attempt
                time.sleep(min(delay, 45))
            elif err.code >= 500:
                time.sleep(min(2 ** attempt, 15))
            else:
                raise InstallError(failure) from err
        except (URLError, TimeoutError, OSError, InstallError) as err:
            failure = str(err)
            if isinstance(err, InstallError) and ("login page" in failure or "invalid Range" in failure
                                                  or "larger than" in failure):
                raise
            if attempt < 4:
                log("  " + label + ": " + failure + "; retrying")
                time.sleep(min(2 ** attempt, 15))
    raise InstallError(failure or label + ": download failed")


def assemble(parts: list[Path], dest: Path) -> Path:
    if len(parts) != len(PARTS):
        raise InstallError("Expected exactly " + str(len(PARTS)) + " payload parts")
    if verified(dest, BUNDLE_SIZE, BUNDLE_SHA256):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".installing")
    try:
        with tmp.open("wb") as out:
            for spec, path in zip(PARTS, parts):
                if not verified(path, spec["size"], spec["sha256"]):
                    raise InstallError("Incorrect payload part: " + spec["name"])
                with path.open("rb") as src:
                    shutil.copyfileobj(src, out, length=BLOCK)
        if not verified(tmp, BUNDLE_SIZE, BUNDLE_SHA256):
            raise InstallError("Assembled Websim payload failed SHA-256 verification")
        tmp.replace(dest)
    finally:
        if tmp.exists():
            tmp.unlink()
    return dest


def select_bundle(requested: Path | None, selected_parts: list[Path] | None, cache: Path) -> Path:
    if requested is not None:
        path = requested.expanduser()
        if not verified(path, BUNDLE_SIZE, BUNDLE_SHA256):
            raise InstallError("--bundle is not this revision's payload ZIP (size/SHA-256 mismatch)")
        log("[1/3] Local Websim payload verified")
        return path
    here = Path(__file__).resolve().parent
    # Explicit parts always take precedence; the website's manual part links
    # also work by double-clicking setup.py with the three files next to it.
    local_parts = [here / spec["name"] for spec in PARTS]
    if selected_parts is not None:
        result = assemble([x.expanduser() for x in selected_parts], cache / "payload.zip")
        log("[1/3] Reassembled manually selected parts; full ZIP SHA-256 OK")
        return result
    # Browsers may append " (1)" when downloading the same ZIP twice.
    nearby = sorted(here.glob("webclient-rescue-payload*.zip"),
                    key=lambda path: path.stat().st_mtime, reverse=True)
    candidates = nearby + [
        here / "build" / "payload.zip",  # local source testing only
        cache / "payload.zip",
    ]
    for path in candidates:
        if verified(path, BUNDLE_SIZE, BUNDLE_SHA256):
            log("[1/3] Local Websim payload verified: " + str(path))
            return path
    if all(path.is_file() for path in local_parts):
        result = assemble(local_parts, cache / "payload.zip")
        log("[1/3] Reassembled three local parts; full ZIP SHA-256 OK")
        return result
    if not SITE_BASE.startswith("https://websim.com/p/"):
        raise InstallError("Put the payload ZIP beside setup.py or use --bundle PATH")
    log("[1/3] Trying direct download from this private Websim project…")
    try:
        parts = [download_checked(SITE_BASE.rstrip("/") + "/" + spec["name"],
                                  cache / spec["name"], spec["size"], spec["sha256"], spec["name"])
                 for spec in PARTS]
    except InstallError as err:
        raise InstallError(str(err) + "\nPut the payload ZIP beside setup.py; "
                           "download it using the button on your signed-in Websim page.") from err
    result = assemble(parts, cache / "payload.zip")
    log("  Reassembled three parts; full ZIP SHA-256 OK")
    return result


def read_bundle(path: Path) -> tuple[dict, list[tuple[dict, bytes]]]:
    if not verified(path, BUNDLE_SIZE, BUNDLE_SHA256):
        raise InstallError("Websim payload ZIP failed SHA-256 verification")
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if len(names) != len(set(names)) or "bundle-manifest.json" not in names:
            raise InstallError("Malformed payload ZIP")
        manifest = json.loads(z.read("bundle-manifest.json"))
        if manifest.get("schema") != 2 or manifest.get("engine_version") != ENGINE_VERSION:
            raise InstallError("Payload was built for a different engine")
        expected_names = {"bundle-manifest.json"}
        records = []
        for spec in manifest["files"]:
            zname = spec["bundle_path"]
            safe_rel(zname)
            if not zname.startswith("files/"):
                raise InstallError("Payload entry is outside files/")
            if spec["target"] != "@userscript":
                safe_rel(spec["target"])
            expected_names.add(zname)
            data = z.read(zname)
            if len(data) != spec["size"] or hashlib.sha256(data).hexdigest() != spec["sha256"]:
                raise InstallError("Bundle file checksum mismatch: " + zname)
            records.append((spec, data))
        if set(names) != expected_names:
            raise InstallError("Payload has unexpected or missing files")
        data_by_target = {row["target"]: data for row, data in records}
        metadata = json.loads(data_by_target["WebClient.metadata.json"])
        expected_sizes = {item["path"].lstrip("/"): item["size"] for item in metadata}
        for key, size in [
            ("shaders/shaders_glsles3_web.pack", 4569049),
            ("content/configs/InExperiencePatchConfig/InExperiencePatchConfig.json", 252),
            ("PlatformContent/pc/fonts/NotoSansCJKjp-Regular.otf", 16427228),
        ]:
            if expected_sizes.get(key) != size or len(data_by_target[key]) != size:
                raise InstallError("Manifest-size gate failed for " + key)
        if sum(x["target"].startswith("content/avatar/compositing/") for x, _ in records) < 19:
            raise InstallError("Avatar compositing mesh set is incomplete")
        if "WebClient.wasm" in data_by_target:
            raise InstallError("Wasm must not be bundled into Websim")
        return manifest, records


def personalized_userscript(original: bytes, place_id: str) -> bytes:
    text = original.decode("utf-8")
    marker = "const TARGET_PLACE_IDS = ['7435428319', '104612064449158'];"
    if text.count(marker) != 1:
        raise InstallError("Could not personalize the userscript's place-ID filter")
    text = text.replace(marker, "const TARGET_PLACE_IDS = ['" + place_id + "'];")
    text = re.sub(r"^// @name\s+.*$", "// @name         WebClient rescue (place " + place_id + ")",
                  text, count=1, flags=re.M)
    return text.encode("utf-8")


def ask_place_id() -> str:
    """Fallback if someone downloads the raw (not personalized) setup.py."""
    if os.name == "nt":
        try:
            import tkinter as tk
            from tkinter import simpledialog
            root = tk.Tk()
            root.withdraw()
            result = simpledialog.askstring("WebClient Rescue", "Numeric ID of a public Roblox place you own:", parent=root)
            root.destroy()
            if result is not None:
                return result.strip()
        except Exception:
            pass
    if sys.stdin and sys.stdin.isatty():
        return input("Numeric ID of a public Roblox place you own: ").strip()
    raise InstallError("No place selected. Pick a public game on the website and download setup.py again.")


def notify_user(title: str, message: str, *, error: bool = False) -> None:
    """Double-clicking setup.py on Windows doesn't require a shell."""
    if os.name != "nt":
        return
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        (messagebox.showerror if error else messagebox.showinfo)(title, message, parent=root)
        root.destroy()
    except Exception:
        if sys.stdin and sys.stdin.isatty():
            input("Press Enter to close…")


def run(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Double-click to install this pinned WebClient build beside setup.py")
    parser.add_argument("--place-id", help="optional numeric ID of a PUBLIC Roblox place you own")
    parser.add_argument("--overrides", type=Path, default=Path(__file__).resolve().parent / "overrides",
                        help="optional custom Chrome DevTools Overrides folder")
    parser.add_argument("--bundle", type=Path, help="ZIP downloaded using the project page (for private auth)")
    parser.add_argument("--parts", nargs=3, type=Path, metavar=("PART1", "PART2", "PART3"),
                        help="manually saved payload parts if the one-click browser button is blocked")
    parser.add_argument("--wasm-file", type=Path, help="use an already verified WebClient.wasm")
    parser.add_argument("--cache-dir", type=Path, default=Path(__file__).resolve().parent / ".webclient-rescue-cache")
    args = parser.parse_args(argv)
    place_id = args.place_id or DEFAULT_PLACE_ID
    if not re.fullmatch(r"[1-9][0-9]{0,18}", place_id):
        place_id = ask_place_id()
    if not re.fullmatch(r"[1-9][0-9]{0,18}", place_id):
        raise InstallError("Place ID must be a positive number. Select your own public place on the website.")
    root = args.overrides.expanduser() / "setup.rbxcdn.com" / "webclient" / ENGINE_VERSION
    log("Override folder: " + str(args.overrides.expanduser()))
    cache = args.cache_dir.expanduser()
    bundle = select_bundle(args.bundle, args.parts, cache)
    manifest, records = read_bundle(bundle)
    wasm = manifest["wasm"]
    destination = root / "WebClient.wasm"
    log("[2/3] Verifying WebClient.wasm from the Internet Archive snapshot…")
    if args.wasm_file:
        copy_verified(args.wasm_file.expanduser(), destination, wasm["size"], wasm["sha256"])
    else:
        download_checked(wasm["url"], destination, wasm["size"], wasm["sha256"], "Archived wasm")
    log("[3/3] Installing exact override files…")
    user_script = Path(__file__).resolve().parent / "roblox-webclient-rescue.user.js"
    written = identical = 0
    for spec, data in records:
        if spec["target"] == "@userscript":
            data = personalized_userscript(data, place_id)
            target = user_script
        else:
            target = root / safe_rel(spec["target"])
        if atomic_bytes(target, data):
            written += 1
        else:
            identical += 1
    log("  " + str(written) + " files written; " + str(identical) + " already matched; no unrelated files deleted")
    log("\nSETUP COMPLETE: " + str(root))
    log("Import/update this userscript in Tampermonkey: " + str(user_script))
    log("In Chrome DevTools > Sources > Overrides, select: " + str(args.overrides.expanduser()))
    log("Keep DevTools attached, open the Overrides pane, then use normal Ctrl+R.")
    log("Do NOT hard-refresh or check Disable cache; that can evict surviving cached files.")
    log("Your place: https://play.roblox.com/games/start?placeId=" + place_id)
    log("The page must request engine " + ENGINE_VERSION + "; another build will not match.")
    log("Audio's unavailable web-only processor is NOT restored. Avatar meshes are included but untested in-game.")
    notify_user("WebClient Rescue — ready",
                "Overrides are ready beside setup.py.\n\n" +
                "1. In Chrome DevTools > Sources > Overrides, select:\n" + str(args.overrides.expanduser()) + "\n" +
                "2. Import roblox-webclient-rescue.user.js into Tampermonkey.\n" +
                "3. Keep DevTools open; use a normal Ctrl+R reload.\n\n" +
                "Place ID: " + place_id)


if __name__ == "__main__":
    try:
        run()
    except (InstallError, zipfile.BadZipFile, json.JSONDecodeError, KeyError) as error:
        text = "SETUP FAILED: " + str(error)
        print(text, file=sys.stderr)
        notify_user("WebClient Rescue — setup failed", text, error=True)
        sys.exit(1)
