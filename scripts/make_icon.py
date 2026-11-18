"""Draw the app icon (assets/icon.png, assets/icon.ico). Run: python -I scripts/make_icon.py"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
OUT = Path(__file__).resolve().parent.parent / "assets"


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # tile: vertical blue gradient, rounded
    tile = Image.new("RGBA", (S, S))
    td = ImageDraw.Draw(tile)
    for y in range(S):
        t = y / S
        td.line([(0, y), (S, y)], fill=(int(52 + 20 * t), int(120 - 40 * t), int(236 - 30 * t), 255))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=255)
    img.paste(tile, (0, 0), mask)

    # page with folded corner
    x0, y0, x1, y1, fold = 250, 170, 774, 854, 150
    page = [(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)]
    d.polygon(page, fill=(255, 255, 255, 255))
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(196, 214, 248, 255))

    # heading bar + text lines
    blue = (47, 98, 222, 255)
    grey = (170, 184, 210, 255)
    d.rounded_rectangle([x0 + 70, 330, x0 + 330, 390], radius=30, fill=blue)
    for i, w in enumerate([380, 330, 380, 250]):
        y = 450 + i * 80
        d.rounded_rectangle([x0 + 70, y, x0 + 70 + w, y + 36], radius=18, fill=grey)
    # reference pill (the viewer's link-to-message feature)
    d.rounded_rectangle([x0 + 250, 750, x0 + 400, 800], radius=25, fill=(255, 196, 61, 255))
    return img


def main() -> None:
    OUT.mkdir(exist_ok=True)
    img = draw()
    img.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    img.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", OUT / "icon.png", OUT / "icon.ico")


if __name__ == "__main__":
    main()
