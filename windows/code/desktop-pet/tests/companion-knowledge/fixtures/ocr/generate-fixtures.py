"""Generate local, synthetic OCR measurement images; contains no user data."""
from pathlib import Path
import hashlib
import json
import struct
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
WIDTH, HEIGHT = 1280, 280
SAMPLES = [
    ("english.png", "Meet at 10:30, room 42.", r"C:\Windows\Fonts\arial.ttf", 56),
    ("simplified-chinese.png", "请在 10:30 到 42 号房间开会。", r"C:\Windows\Fonts\msyh.ttc", 56),
]

def png_chunks(path: Path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    offset = 8
    types = []
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        chunk_type = data[offset + 4:offset + 8].decode("ascii")
        types.append(chunk_type)
        offset += 12 + length
        if chunk_type == "IEND":
            break
    assert offset == len(data), "trailing bytes after PNG IEND"
    assert types[0] == "IHDR" and types[-1] == "IEND"
    assert all(kind not in {"tEXt", "zTXt", "iTXt", "eXIf"} for kind in types), types
    return types

report = {"imageSize": [WIDTH, HEIGHT], "samples": []}
for name, expected, font_path, font_size in SAMPLES:
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(font_path, font_size)
    bbox = draw.textbbox((0, 0), expected, font=font, stroke_width=1)
    x = (WIDTH - (bbox[2] - bbox[0])) // 2 - bbox[0]
    y = (HEIGHT - (bbox[3] - bbox[1])) // 2 - bbox[1]
    draw.text((x, y), expected, fill=(0, 0, 0), font=font, stroke_width=1)
    path = ROOT / name
    image.save(path, format="PNG", optimize=False)
    report["samples"].append({
        "file": name,
        "expected": expected,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": path.stat().st_size,
        "chunks": png_chunks(path),
    })

blank = Image.new("RGB", (400, 120), "white")
blank_path = ROOT / "blank.png"
blank.save(blank_path, format="PNG", optimize=False)
report["blank"] = {
    "file": blank_path.name,
    "sha256": hashlib.sha256(blank_path.read_bytes()).hexdigest(),
    "bytes": blank_path.stat().st_size,
    "chunks": png_chunks(blank_path),
}
print(json.dumps(report, ensure_ascii=False, indent=2))
