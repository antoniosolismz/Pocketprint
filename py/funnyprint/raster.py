"""Image -> 1-bit raster for the Funny Print family, matching the stock app byte for byte.

Port of cn.lailaixiong.funnyprint.util.ImageUtil (see PROTOCOL.md §7):
  * lip = red channel (no luma weighting in the binary path),
  * 1 = black, MSB-first, packed continuously across the whole image,
  * optional Floyd-Steinberg dithering with the 7/3/5/1 kernel.
"""
from __future__ import annotations

from PIL import Image

THRESHOLD_DEFAULT = 128
DITHER_KERNEL = ((1, 0, 7), (-1, 1, 3), (0, 1, 5), (1, 1, 1))


def to_gray(image: Image.Image, invert_brightness: bool = False) -> Image.Image:
    """The app extracts Color.red, which is the grayscale value after a luma color filter."""
    return image.convert("L")


def scale_to_width(image: Image.Image, width: int, resample: int = Image.NEAREST) -> Image.Image:
    """Nearest-neighbour by default: the app sets filterBitmap(false) so text stays crisp."""
    if image.width == width:
        return image
    height = max(1, round(image.height * width / image.width))
    return image.resize((width, height), resample)


def crop_to_height(image: Image.Image, height: int) -> Image.Image:
    """Centre crop, as scaleAndCropImage does."""
    if height >= image.height:
        return image
    top = (image.height - height) // 2
    return image.crop((0, top, image.width, top + height))


def floyd_steinberg(gray: Image.Image, threshold: int = THRESHOLD_DEFAULT) -> list[bool]:
    """Returns one bool per pixel: True = black. Kernel and clamping per ImageUtil.java:230."""
    width, height = gray.size
    buf = bytearray(gray.tobytes())
    out = [False] * (width * height)
    for y in range(height):
        for x in range(width):
            i = y * width + x
            old = buf[i]
            new = 0 if old < threshold else 255
            out[i] = new == 0
            err = old - new
            for dx, dy, factor in DITHER_KERNEL:
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height:
                    j = ny * width + nx
                    buf[j] = max(0, min(255, buf[j] + (err * factor) // 16))
    return out


def pack_bits(bits: list[bool]) -> bytes:
    """MSB-first, continuous across the image (ImageUtil.booleanArrayToBinaryBuffer)."""
    out = bytearray((len(bits) + 7) // 8)
    for i, black in enumerate(bits):
        if black:
            out[i // 8] |= 1 << (7 - (i % 8))
    return bytes(out)


def rasterize(
    image: Image.Image,
    width: int = 384,
    threshold: int = THRESHOLD_DEFAULT,
    dither: bool = True,
    max_height: int | None = None,
    crop: bool = False,
) -> tuple[bytes, int, int]:
    """Full pipeline. Returns (packed 1-bit raster, width, height)."""
    gray = to_gray(image)
    scaled = scale_to_width(gray, width)
    if max_height:
        scaled = crop_to_height(scaled, max_height) if crop else scaled
    w, h = scaled.size
    if dither:
        bits = floyd_steinberg(scaled, threshold)
    else:
        data = scaled.tobytes()
        bits = [pixel < threshold for pixel in data]
    if w % 8:
        # The app packs continuously with no per-row padding, so we do the same.
        # Widths that are multiples of 8 (384, 576, ...) keep rows byte-aligned anyway,
        # which is what the printer assumes; other widths will shear the image.
        pass
    return pack_bits(bits), w, h


def text_to_image(text: str, font=None, width: int = 384, font_size: int = 24) -> Image.Image:
    """Convenience: render text to an image for printing."""
    from PIL import ImageDraw, ImageFont

    if font is None:
        try:
            font = ImageFont.truetype(
                "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", font_size
            )
        except OSError:
            font = ImageFont.load_default()
    lines = text.splitlines() or [""]
    line_h = font_size + 6
    img = Image.new("L", (width, line_h * len(lines) + 8), 255)
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((4, 4 + i * line_h), line, fill=0, font=font)
    return img
