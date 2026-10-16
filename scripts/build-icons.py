"""Extract the supplied blue logo and build macOS icons (Python + Pillow)."""

from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
source = Image.open(ROOT / "assets/branding/source.png").convert("RGB")
# The subject is blue/cyan; the background and lower-right caption are neutral.
red, green, blue = source.split()
chroma = ImageChops.subtract(blue, red)
bounds = chroma.point(lambda value: 255 if value > 40 else 0).getbbox()
if bounds is None:
    raise ValueError("No blue subject found in source image")
# Retain a few pixels for antialiased edges before trimming transparent margins.
left, top, right, bottom = bounds
bounds = (max(0, left - 3), max(0, top - 3), min(source.width, right + 3), min(source.height, bottom + 3))
subject = source.crop(bounds).convert("RGBA")
chroma = chroma.crop(bounds)
nearby = chroma.filter(ImageFilter.MaxFilter(9))
interior = chroma.point(lambda value: 255 if value > 40 else 0).filter(ImageFilter.MinFilter(5))


def data(image):
    return image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata()


pixels = []
for pixel, saturation, reference, inside in zip(data(subject), data(chroma), data(nearby), data(interior)):
    if inside:
        pixels.append(pixel)
    elif saturation < 10 or reference < 100:
        pixels.append((0, 0, 0, 0))
    else:
        # Unmix the nearly white background at the antialiased outline.
        alpha = min(1, saturation / reference)
        rgb = tuple(max(0, min(255, round((value - 253 * (1 - alpha)) / alpha))) for value in pixel[:3])
        pixels.append((*rgb, round(alpha * 255)))
subject.putdata(pixels)
subject = subject.crop(subject.getbbox())


def centered(size, content_size):
    canvas = Image.new("RGBA", (size, size))
    content = subject.copy()
    content.thumbnail((content_size, content_size), Image.Resampling.LANCZOS)
    canvas.alpha_composite(content, ((size - content.width) // 2, (size - content.height) // 2))
    return canvas


(ROOT / "public").mkdir(exist_ok=True)
(ROOT / "build").mkdir(exist_ok=True)
centered(1024, 1024).save(ROOT / "assets/branding/logo.png")
centered(128, 128).save(ROOT / "public/logo.png")
# Transparent breathing room keeps the Dock icon aligned with other macOS apps.
icon = centered(1024, 864)
icon.save(ROOT / "build/icon.png")
with tempfile.TemporaryDirectory(prefix="trident-icons-") as temporary:
    iconset = Path(temporary) / "Trident.iconset"
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            suffix = "@2x" if scale == 2 else ""
            icon.resize((size * scale, size * scale), Image.Resampling.LANCZOS).save(iconset / f"icon_{size}x{size}{suffix}.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ROOT / "build/icon.icns")], check=True)
print("Generated logo.png, public/logo.png, build/icon.png and build/icon.icns")
