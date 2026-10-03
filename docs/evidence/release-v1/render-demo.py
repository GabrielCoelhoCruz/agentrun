"""Render sanitized fixture frames: uv run --no-project --with pillow==12.0.0 render-demo.py."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
font_path = '/System/Library/Fonts/Menlo.ttc'
if not Path(font_path).is_file():
 font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
font = ImageFont.truetype(font_path, 16)
images = []
for lines in json.loads((root / 'demo-frames.json').read_text()):
 image = Image.new('RGB', (840, 336), '#10151d')
 draw = ImageDraw.Draw(image)
 draw.text((20, 16), 'agentrun | deterministic test providers', font=font, fill='#7dd3fc')
 for row, line in enumerate(lines):
  draw.text((20, 52 + row * 24), line, font=font, fill='#e5e7eb')
 images.append(image)
images[0].save(root / 'demo.gif', save_all=True, append_images=images[1:], duration=700, loop=0)
images[-1].save(root / 'demo-final.png')
