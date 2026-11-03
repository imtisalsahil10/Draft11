"""Read player data from the pixels of a Draft11 card image.

The previous catalogue pass asked Windows OCR to read a tall crop that still
contained the portrait, and it only accepted near-white pixels as rating and
position text. Gold lettering such as ROMAGNOLI / 91 / CB was therefore stored
as a broken name and as missing fields. This reader crops the rating, the
position, the name band, and the attribute block separately, renders the ink
as black text on white, and sends those regions to Windows OCR.

Nationality is classified from the flag colours under the position. There is
no crest-to-club table in this project, so a visible crest is recorded without
inventing a club name. A value that is not read stays null.
"""

import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFont
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
OCR_SCRIPT = Path(__file__).resolve().parent / 'ocr-card-crops.ps1'

ROLES = (
    'CDM', 'CAM', 'LWB', 'RWB', 'CB', 'LB', 'RB', 'CM', 'LM', 'RM',
    'LW', 'RW', 'CF', 'ST', 'GK'
)
OUTFIELD_LABELS = {
    'PAC': 'pace',
    'SHO': 'shooting',
    'PAS': 'passing',
    'DRI': 'dribbling',
    'DEF': 'defending',
    'PHY': 'physical'
}
KEEPER_LABELS = {
    'DIV': 'diving',
    'HAN': 'handling',
    'KIC': 'kicking',
    'REF': 'reflexes',
    'SPE': 'speed',
    'SPD': 'speed',
    'POS': 'positioning'
}
GEOM_OUT = ('pace', 'dribbling', 'shooting', 'defending', 'passing', 'physical')
GEOM_GK = ('diving', 'reflexes', 'handling', 'speed', 'kicking', 'positioning')
SMALL_WORDS = {'DE', 'DA', 'DI', 'DO', 'DU', 'DEL', 'VAN', 'VON', 'DER', 'LA', 'LE'}
VERTICAL_FLAGS = {
    ('green', 'white', 'red'): 'Italy',
    ('blue', 'white', 'red'): 'France',
    ('black', 'yellow', 'red'): 'Belgium',
    ('green', 'white', 'orange'): 'Ireland',
    ('orange', 'white', 'green'): 'Ivory Coast',
    ('blue', 'yellow', 'red'): 'Romania',
    ('red', 'white', 'red'): 'Peru',
    ('green', 'white', 'green'): 'Nigeria',
    ('lightblue', 'white', 'lightblue'): 'Argentina',
    ('blue', 'white', 'blue'): 'Argentina',
    ('red', 'white', 'black'): 'Egypt',
    ('green', 'yellow', 'red'): 'Mali',
    ('yellow', 'green', 'red'): 'Senegal',
    ('green', 'red', 'yellow'): 'Cameroon'
}
HORIZONTAL_FLAGS = {
    ('black', 'red', 'yellow'): 'Germany',
    ('red', 'yellow', 'red'): 'Spain',
    ('red', 'white', 'blue'): 'Netherlands',
    ('white', 'blue', 'red'): 'Russia',
    ('red', 'white', 'red'): 'Austria',
    ('white', 'green', 'red'): 'Bulgaria',
    ('lightblue', 'white', 'lightblue'): 'Argentina',
    ('blue', 'white', 'blue'): 'Argentina'
}


def load_card(path):
    image = Image.open(path)
    image.load()
    rgba = image.convert('RGBA')
    arr = np.asarray(rgba)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]
    height, width = alpha.shape
    if float((alpha < 250).mean()) > 0.02:
        ys, xs = np.nonzero(alpha > 16)
        if len(xs):
            box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        else:
            box = (0, 0, width, height)
    else:
        box = (0, 0, width, height)
    return rgb, alpha, box


def ink_masks(rgb, alpha):
    red = rgb[:, :, 0].astype(np.int16)
    green = rgb[:, :, 1].astype(np.int16)
    blue = rgb[:, :, 2].astype(np.int16)
    lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    visible = alpha > 16
    light = visible & (lum > 158) & (red > 140) & (green > 120) & ((blue + 30 < red) | (lum > 185))
    dark = visible & (lum < 72) & (red < 100) & (green < 100) & (blue < 110)
    return light, dark


def close_vertical(mask):
    return ndimage.binary_closing(mask, structure=np.ones((3, 1), dtype=bool))


def components(mask, region, min_h, max_h, min_w=2):
    x0, y0, x1, y1 = region
    if x1 <= x0 or y1 <= y0:
        return []
    sub = mask[y0:y1, x0:x1]
    labels, _count = ndimage.label(sub)
    found = []
    region_w = x1 - x0
    region_h = y1 - y0
    for index, slc in enumerate(ndimage.find_objects(labels), start=1):
        if slc is None:
            continue
        patch = labels[slc] == index
        area = int(patch.sum())
        if area < 8:
            continue
        gy0, gy1 = slc[0].start, slc[0].stop
        gx0, gx1 = slc[1].start, slc[1].stop
        box_h, box_w = gy1 - gy0, gx1 - gx0
        if box_h < min_h or box_h > max_h or box_w < min_w:
            continue
        if box_w > region_w * 0.72 and box_h > region_h * 0.55:
            continue
        if box_w > box_h * 6 and box_h < max(6, min_h):
            continue
        found.append((x0 + gx0, y0 + gy0, x0 + gx1, y0 + gy1))
    return found


def glyph_h(glyph):
    return glyph[3] - glyph[1]


def glyph_w(glyph):
    return glyph[2] - glyph[0]


def center_y(glyph):
    return (glyph[1] + glyph[3]) / 2


def center_x(glyph):
    return (glyph[0] + glyph[2]) / 2


def cluster_rows(glyphs, tolerance=0.65):
    rows = []
    for glyph in sorted(glyphs, key=center_y):
        cy = center_y(glyph)
        height = glyph_h(glyph)
        placed = False
        for row in rows:
            if abs(cy - row['cy']) <= max(height, row['h']) * tolerance:
                row['glyphs'].append(glyph)
                row['cy'] = sum(center_y(item) for item in row['glyphs']) / len(row['glyphs'])
                row['h'] = max(glyph_h(item) for item in row['glyphs'])
                placed = True
                break
        if not placed:
            rows.append({'glyphs': [glyph], 'cy': cy, 'h': height})
    for row in rows:
        row['glyphs'].sort(key=lambda item: item[0])
    return rows


def content_size(box):
    return box[2] - box[0], box[3] - box[1]


def line_score(row):
    width = sum(glyph_w(glyph) for glyph in row['glyphs'])
    return width * row['h']


def contiguous_runs(glyphs, height):
    if not glyphs:
        return []
    ordered = sorted(glyphs, key=lambda glyph: glyph[0])
    runs = [[ordered[0]]]
    limit = max(6, height * 0.7)
    for glyph in ordered[1:]:
        if glyph[0] - runs[-1][-1][2] > limit:
            runs.append([glyph])
        else:
            runs[-1].append(glyph)
    return runs


def select_name_row(rows, box):
    _width, height = content_size(box)
    top = box[1] + height * 0.45
    bottom = box[1] + height * 0.78
    candidates = []
    for row in rows:
        if not top <= row['cy'] <= bottom:
            continue
        if not height * 0.035 <= row['h'] <= height * 0.09:
            continue
        for run in contiguous_runs(row['glyphs'], row['h']):
            if not 3 <= len(run) <= 16:
                continue
            width = sum(glyph_w(glyph) for glyph in run)
            if width < row['h'] * 1.4:
                continue
            # Taller lettering is the printed name. Attribute rows are shorter and wider.
            candidates.append((row['h'] * 80 + width, run, row))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    _score, run, row = candidates[0]
    return {'glyphs': run, 'cy': row['cy'], 'h': row['h']}


def select_rating_row(rows, box):
    _width, height = content_size(box)
    limit = box[1] + height * 0.46
    pairs = []
    for row in rows:
        if row['cy'] > limit or len(row['glyphs']) < 2:
            continue
        glyphs = row['glyphs']
        for index, left in enumerate(glyphs):
            if glyph_h(left) < height * 0.055:
                continue
            for right in glyphs[index + 1:index + 3]:
                if abs(glyph_h(left) - glyph_h(right)) > max(glyph_h(left), glyph_h(right)) * 0.28:
                    continue
                gap = right[0] - left[2]
                if glyph_w(left) < glyph_h(left) * 0.18 or glyph_w(right) < glyph_h(right) * 0.18:
                    continue
                if gap < -2 or gap > max(glyph_h(left), 8) * 0.45:
                    continue
                if glyph_w(left) > glyph_h(left) or glyph_w(right) > glyph_h(right):
                    continue
                pairs.append((left, right))
    if not pairs:
        return None
    pairs.sort(key=lambda pair: (-(glyph_h(pair[0]) + glyph_h(pair[1])), pair[0][0]))
    return pairs[0]


def select_position_glyphs(rows, rating_pair, box):
    if not rating_pair:
        return []
    left, right = rating_pair
    base = max(left[3], right[3])
    rating_h = max(glyph_h(left), glyph_h(right))
    x_left = min(left[0], right[0]) - rating_h * 0.35
    x_right = max(left[2], right[2]) + rating_h * 0.85
    chosen = []
    for row in rows:
        if row['cy'] < base - 2 or row['cy'] > base + rating_h * 0.95:
            continue
        for glyph in row['glyphs']:
            if glyph in (left, right):
                continue
            height = glyph_h(glyph)
            if not rating_h * 0.32 <= height <= rating_h * 0.78:
                continue
            if center_x(glyph) < x_left or center_x(glyph) > x_right + rating_h:
                continue
            if glyph_w(glyph) > height * 1.35:
                continue
            chosen.append(glyph)
    if not chosen:
        return []
    runs = contiguous_runs(chosen, rating_h * 0.45)
    rating_center = (left[0] + right[2]) / 2
    runs.sort(key=lambda run: abs((center_x(run[0]) + center_x(run[-1])) / 2 - rating_center))
    primary = runs[0]
    return primary[:3]


def trim_ink(mask_crop):
    ys, xs = np.nonzero(mask_crop)
    if len(xs) == 0:
        return None
    return mask_crop[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def render_mask(mask_crop, target_h):
    trimmed = trim_ink(mask_crop)
    if trimmed is None or trimmed.shape[0] < 4 or trimmed.shape[1] < 2:
        return None
    scale = target_h / trimmed.shape[0]
    width = max(1, int(round(trimmed.shape[1] * scale)))
    image = Image.fromarray(np.where(trimmed, 0, 255).astype(np.uint8), mode='L')
    return image.resize((width, target_h), Image.Resampling.NEAREST)


def render_glyphs(mask, glyphs, target_h, gap_ratio=0.18):
    parts = []
    for glyph in glyphs:
        part = render_mask(mask[glyph[1]:glyph[3], glyph[0]:glyph[2]], target_h)
        if part is not None:
            parts.append(part)
    if not parts:
        return None
    gap = max(2, int(target_h * gap_ratio))
    width = sum(part.width for part in parts) + gap * (len(parts) - 1)
    canvas = Image.new('L', (width, target_h), 255)
    cursor = 0
    for part in parts:
        canvas.paste(part, (cursor, 0))
        cursor += part.width + gap
    return canvas


def pad_image(image, margin=22):
    canvas = Image.new('L', (image.width + margin * 2, image.height + margin * 2), 255)
    canvas.paste(image, (margin, margin))
    return canvas.convert('RGB')


def with_prefix(image, prefix):
    """A real word beside the glyph gives Windows OCR a line it is willing to read."""
    target_h = max(image.height, 48)
    if image.height != target_h:
        image = image.resize((max(1, int(image.width * target_h / image.height)), target_h), Image.Resampling.NEAREST)
    font = ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf', target_h)
    probe = Image.new('L', (target_h * 8, target_h * 2), 255)
    ImageDraw.Draw(probe).text((0, 0), f'{prefix} ', fill=0, font=font)
    arr = np.asarray(probe)
    ys, xs = np.nonzero(arr < 128)
    if len(xs) == 0:
        return pad_image(image)
    crop = probe.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    scaled = crop.resize((max(1, int(crop.width * target_h / crop.height)), target_h), Image.Resampling.LANCZOS)
    gap = max(8, target_h // 3)
    canvas = Image.new('L', (scaled.width + gap + image.width, target_h), 255)
    canvas.paste(scaled, (0, 0))
    canvas.paste(image, (scaled.width + gap, 0))
    return pad_image(canvas, 24)


def name_image(mask, row):
    glyphs = row['glyphs']
    x0 = min(glyph[0] for glyph in glyphs) - 2
    x1 = max(glyph[2] for glyph in glyphs) + 2
    y0 = min(glyph[1] for glyph in glyphs) - 1
    y1 = max(glyph[3] for glyph in glyphs) + 1
    x0 = max(0, x0)
    y0 = max(0, y0)
    x1 = min(mask.shape[1], x1)
    y1 = min(mask.shape[0], y1)
    crop = mask[y0:y1, x0:x1]
    # Drop a rule sitting under the capitals.
    if crop.shape[0] > 6:
        density = crop.mean(axis=1)
        cut = crop.shape[0]
        for index in range(crop.shape[0] - 1, int(crop.shape[0] * 0.62), -1):
            if density[index] > 0.62:
                cut = index
            else:
                break
        crop = crop[:cut]
    rendered = render_mask(crop, 64)
    if rendered is None:
        return None
    return pad_image(rendered)


def drop_left_badges(glyphs):
    ordered = sorted(glyphs, key=lambda glyph: glyph[0])
    if len(ordered) < 5:
        return ordered
    gaps = [ordered[index + 1][0] - ordered[index][2] for index in range(len(ordered) - 1)]
    median = sorted(gaps)[len(gaps) // 2]
    for index, gap in enumerate(gaps[:3]):
        if gap > max(12, median * 1.6):
            return ordered[index + 1:]
    return ordered


def stat_cells(mask, box, name_row):
    """Three rows and two columns under the name: the six face-card attributes."""
    card_w, card_h = content_size(box)
    name_h = name_row['h'] if name_row else card_h * 0.055
    name_bottom = max(glyph[3] for glyph in name_row['glyphs']) + 4 if name_row else box[1] + int(card_h * 0.64)
    min_h = max(7, int(name_h * 0.45))
    max_h = max(min_h + 2, int(name_h * 0.95))
    region = (
        box[0] + int(card_w * 0.08),
        name_bottom,
        box[0] + int(card_w * 0.98),
        box[1] + int(card_h * 0.96)
    )
    glyphs = components(mask, region, min_h, max_h)
    rows = [row for row in cluster_rows(glyphs, 0.55) if len(row['glyphs']) >= 4]
    if len(rows) > 3:
        ranked = sorted(rows, key=lambda row: sum(glyph_w(glyph) for glyph in row['glyphs']), reverse=True)
        keep = {id(row) for row in ranked[:3]}
        rows = [row for row in rows if id(row) in keep]
    rows.sort(key=lambda row: row['cy'])
    cells = []
    for row in rows[:3]:
        split = split_columns(drop_left_badges(row['glyphs']))
        if not split:
            continue
        cells.extend(split)
    return cells


def color_position_crop(rgb, rating_pair):
    """The gold position sits directly under the rating. Read that artwork, not a rebuilt glyph."""
    if not rating_pair:
        return None
    left, right = rating_pair
    rating_h = max(glyph_h(left), glyph_h(right))
    x0 = max(0, min(left[0], right[0]) - 2)
    x1 = min(rgb.shape[1], max(left[2], right[2]) + 4)
    y0 = max(0, max(left[3], right[3]) + 1)
    y1 = min(rgb.shape[0], y0 + max(12, int(rating_h * 0.62)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    crop = Image.fromarray(rgb[y0:y1, x0:x1])
    arr = np.asarray(crop).astype(np.float32)
    ink = arr.mean(axis=2) > 150
    rendered = render_mask(ink, 64)
    if rendered is None:
        return None
    return with_prefix(rendered, 'POS')


def color_stat_cell(rgb, glyphs):
    """Windows OCR reads these digits reliably when a plain word sits under them."""
    height, width = rgb.shape[:2]
    x0 = max(0, min(glyph[0] for glyph in glyphs) - 6)
    y0 = max(0, min(glyph[1] for glyph in glyphs) - 4)
    x1 = min(width, max(glyph[2] for glyph in glyphs) + 6)
    y1 = min(height, max(glyph[3] for glyph in glyphs) + 4)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    crop = Image.fromarray(rgb[y0:y1, x0:x1]).resize(((x1 - x0) * 3, (y1 - y0) * 3), Image.Resampling.LANCZOS)
    crop = ImageEnhance.Contrast(crop).enhance(1.4)
    font = ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf', 28)
    canvas = Image.new('RGB', (crop.width + 24, crop.height + 46), (16, 22, 40))
    canvas.paste(crop, (12, 8))
    ImageDraw.Draw(canvas).text((12, crop.height + 8), 'STAT', fill=(255, 255, 255), font=font)
    return canvas


def split_columns(glyphs):
    ordered = sorted(glyphs, key=lambda glyph: glyph[0])
    if len(ordered) < 4:
        return None
    gaps = []
    for index in range(len(ordered) - 1):
        gap = ordered[index + 1][0] - ordered[index][2]
        gaps.append((gap, index))
    gaps.sort(reverse=True)
    gap, index = gaps[0]
    median_gap = sorted(item[0] for item in gaps)[len(gaps) // 2]
    if gap < max(6, median_gap * 1.4):
        return None
    left = ordered[:index + 1]
    right = ordered[index + 1:]
    if len(left) < 2 or len(right) < 2:
        return None
    return left, right


def colour_bucket(pixel):
    red, green, blue = [int(channel) / 255 for channel in pixel[:3]]
    peak = max(red, green, blue)
    floor = min(red, green, blue)
    lum = (peak + floor) / 2
    if peak - floor < 1e-6:
        if lum > 0.72:
            return 'white'
        if lum < 0.18:
            return 'black'
        return 'gray'
    sat = (peak - floor) / (1 - abs(2 * lum - 1)) if 1 - abs(2 * lum - 1) else 0
    if lum > 0.72 and sat < 0.45:
        return 'white'
    if sat < 0.18:
        if lum > 0.74:
            return 'white'
        if lum < 0.16:
            return 'black'
        return 'gray'
    if peak == red:
        hue = ((green - blue) / (peak - floor)) % 6
    elif peak == green:
        hue = (blue - red) / (peak - floor) + 2
    else:
        hue = (red - green) / (peak - floor) + 4
    hue *= 60
    if hue < 18 or hue >= 345:
        return 'red'
    if hue < 48:
        return 'orange' if green > 0.45 else 'red'
    if hue < 75:
        return 'yellow'
    if hue < 165:
        return 'green'
    if hue < 200:
        return 'cyan'
    if lum > 0.62 and 185 <= hue < 230:
        return 'lightblue'
    if hue < 255:
        return 'blue'
    return 'purple'


def dominant_bucket(pixels):
    if len(pixels) == 0:
        return None
    counts = {}
    for pixel in pixels:
        bucket = colour_bucket(pixel)
        if bucket in {'cyan', 'gray', 'purple'}:
            continue
        counts[bucket] = counts.get(bucket, 0) + 1
    if not counts:
        return None
    winner = max(counts, key=counts.get)
    if counts[winner] < len(pixels) * 0.38:
        return None
    return winner


def flag_crop(rgb, rating_pair, position_glyphs, box):
    if not rating_pair:
        return None
    left, right = rating_pair
    card_w, card_h = content_size(box)
    anchor_y = max(glyph[3] for glyph in position_glyphs) + 2 if position_glyphs else max(left[3], right[3]) + int(card_h * 0.04)
    center = (min(left[0], right[0]) + max(left[2], right[2])) / 2
    width = max(int(card_w * 0.15), int((max(left[2], right[2]) - min(left[0], right[0])) * 1.45))
    height = max(12, int(width * 0.62))
    x0 = int(center - width / 2)
    best = None
    best_score = -1
    y_limit = int(anchor_y + max(height, card_h * 0.08))
    for y0 in range(int(anchor_y), max(int(anchor_y) + 1, y_limit)):
        sx0 = max(box[0], x0)
        sx1 = min(box[2], x0 + width)
        sy1 = min(box[3], y0 + height)
        if sy1 - y0 < height * 0.75 or sx1 - sx0 < width * 0.7:
            continue
        crop = rgb[y0:sy1, sx0:sx1]
        score = float(crop.astype(np.float32).std())
        if score > best_score:
            best_score = score
            best = (sx0, y0, sx1, sy1)
    if best is None or best_score < 28:
        return None
    return best


def colourfulness(crop):
    arr = crop.astype(np.int16)
    peak = arr.max(axis=2)
    floor = arr.min(axis=2)
    sat = (peak - floor) / np.maximum(peak, 1)
    return float((sat > 0.28).mean() * 100)


def trim_dark_margins(crop):
    """Drop uniform dark rows above or below a flag. Colour stripes stay, even a dark blue one."""
    if crop.shape[0] < 8 or crop.shape[1] < 8:
        return crop
    arr = crop.astype(np.float32)

    def pad_row(index):
        row = arr[index]
        return float(row.mean()) < 100 and float(row.std()) < 42

    top = 0
    while top < crop.shape[0] - 4 and pad_row(top):
        top += 1
    bottom = crop.shape[0]
    while bottom - top > 4 and pad_row(bottom - 1):
        bottom -= 1
    return crop[top:bottom]


def colour_profile(crop, axis):
    """Collapse a flag to the colour bands running across it or down it."""
    if crop.shape[0] < 6 or crop.shape[1] < 10:
        return []
    if axis == 1:
        inset = max(1, crop.shape[0] // 5)
        band = crop[inset:crop.shape[0] - inset]
        if band.shape[0] < 2:
            band = crop
        colours = [dominant_bucket(band[:, column].reshape(-1, 3)) for column in range(band.shape[1])]
    else:
        inset = max(1, crop.shape[1] // 5)
        band = crop[:, inset:crop.shape[1] - inset]
        if band.shape[1] < 2:
            band = crop
        colours = [dominant_bucket(band[row].reshape(-1, 3)) for row in range(band.shape[0])]
    runs = []
    for colour in colours:
        if colour in {None, 'gray', 'cyan', 'purple'}:
            continue
        if not runs or runs[-1][0] != colour:
            runs.append([colour, 1])
        else:
            runs[-1][1] += 1
    return [colour for colour, count in runs if count >= len(colours) * 0.12]


def stripe_colour(cells):
    """A sun or crest may sit in the middle of a stripe. The two edges name the stripe."""
    if cells[0] and cells[0] == cells[2]:
        return cells[0]
    if cells[0] and cells[0] == cells[1] == cells[2]:
        return cells[0]
    return None


def classify_flag(rgb, bounds):
    if not bounds:
        return None, False
    x0, y0, x1, y1 = bounds
    crop = trim_dark_margins(rgb[y0:y1, x0:x1])
    if crop.shape[0] < 6 or crop.shape[1] < 10:
        return None, False
    grid = []
    for row in range(3):
        line = []
        for col in range(3):
            ys = int(crop.shape[0] * row / 3)
            ye = int(crop.shape[0] * (row + 1) / 3)
            xs = int(crop.shape[1] * col / 3)
            xe = int(crop.shape[1] * (col + 1) / 3)
            line.append(dominant_bucket(crop[ys:ye, xs:xe].reshape(-1, 3)))
        grid.append(line)
    columns = tuple(stripe_colour([grid[row][col] for row in range(3)]) for col in range(3))
    rows = tuple(stripe_colour(grid[row]) for row in range(3))
    vertical_runs = tuple(colour_profile(crop, 1))
    horizontal_runs = tuple(colour_profile(crop, 0))
    nation = VERTICAL_FLAGS.get(vertical_runs) if len(set(vertical_runs)) >= 2 else None
    if nation == 'Italy' and not white_stripe_is_plain(crop, axis=1):
        nation = None
    if nation is None and len(set(horizontal_runs)) >= 2:
        nation = HORIZONTAL_FLAGS.get(horizontal_runs)
    if nation:
        return nation, True
    if None not in columns and len(set(columns)) >= 2:
        nation = VERTICAL_FLAGS.get(columns)
        if nation == 'Italy' and not white_stripe_is_plain(crop, axis=1):
            nation = None
    if nation is None and None not in rows and len(set(rows)) >= 2:
        nation = HORIZONTAL_FLAGS.get(rows)
        # Germany and Spain are horizontal. A vertical match already won when it was clean.
        if columns == rows:
            pass
    if nation is None:
        nation = special_flag(crop, grid)
    return nation, bool(nation)


def white_stripe_is_plain(crop, axis):
    if axis == 1:
        mid = crop[:, crop.shape[1] // 3: crop.shape[1] * 2 // 3]
    else:
        mid = crop[crop.shape[0] // 3: crop.shape[0] * 2 // 3, :]
    arr = mid.astype(np.float32)
    peak = arr.max(axis=2)
    floor = arr.min(axis=2)
    sat = (peak - floor) / np.maximum(peak, 1)
    return float(sat.mean()) < 0.38


def special_flag(crop, grid):
    flat = [cell for row in grid for cell in row]
    corners = [grid[0][0], grid[0][2], grid[2][0], grid[2][2]]
    if corners.count('green') >= 3 and grid[1][1] in {'yellow', 'green'}:
        return 'Brazil'
    if corners.count('white') >= 3 and grid[1][1] == 'red' and grid[0][1] == 'red' and grid[1][0] == 'red':
        return 'England'
    if corners.count('red') >= 3 and grid[1][1] == 'white':
        return 'Switzerland' if abs((crop.shape[1] / crop.shape[0]) - 1) < 0.18 else 'Denmark'
    if corners.count('red') >= 3 and grid[1][1] in {'blue', 'lightblue'}:
        return 'Norway'
    if flat.count('white') >= 6 and grid[1][1] == 'red':
        return 'Japan'
    left = crop[:, : crop.shape[1] // 2]
    right = crop[:, crop.shape[1] // 2:]
    if dominant_bucket(left.reshape(-1, 3)) == 'green' and dominant_bucket(right.reshape(-1, 3)) == 'red':
        if grid[0][1] != 'white' and grid[1][1] != 'white':
            return 'Portugal'
    return None


def crest_visible(rgb, flag_bounds, box):
    if not flag_bounds:
        return False
    _x0, _y0, x1, y1 = flag_bounds
    card_w, card_h = content_size(box)
    width = x1 - flag_bounds[0]
    region = rgb[y1 + 2: min(box[3], y1 + int(card_h * 0.11)), max(box[0], flag_bounds[0] - 2): min(box[2], flag_bounds[0] + width + 4)]
    if region.size == 0:
        return False
    return float(region.astype(np.float32).std()) > 24


def prepare_card(path, crop_dir, stem):
    rgb, alpha, box = load_card(path)
    light, dark = ink_masks(rgb, alpha)
    card_w, card_h = content_size(box)
    name_zone = (box[0] + int(card_w * 0.06), box[1] + int(card_h * 0.40), box[0] + int(card_w * 0.94), box[1] + int(card_h * 0.82))
    rating_zone = (box[0], box[1], box[0] + int(card_w * 0.48), box[1] + int(card_h * 0.46))
    best_name = None
    best_rating = None
    for polarity, source in (('light', light), ('dark', dark)):
        closed = close_vertical(source)
        eroded = close_vertical(ndimage.binary_erosion(source, iterations=1))
        name_rows = cluster_rows(components(closed, name_zone, max(7, int(card_h * 0.03)), int(card_h * 0.1)))
        name_row = select_name_row(name_rows, box)
        if name_row:
            score = line_score(name_row)
            if best_name is None or score > best_name[0]:
                best_name = (score, polarity, source, closed, name_row)
        for kind, mask in (('closed', closed), ('eroded', eroded)):
            rating_rows = cluster_rows(components(mask, rating_zone, max(8, int(card_h * 0.045)), int(card_h * 0.16)))
            rating = select_rating_row(rating_rows, box)
            if not rating:
                continue
            height = glyph_h(rating[0]) + glyph_h(rating[1]) + (30 if kind == 'closed' else 0)
            if best_rating is None or height > best_rating[0]:
                best_rating = (height, source, rating_rows, rating)
    if best_name is None:
        polarity, mask, closed, name_row = 'light', light, close_vertical(light), None
    else:
        _score, polarity, mask, closed, name_row = best_name
    if best_rating is None:
        rating = None
        rating_rows = []
        rating_source = mask
    else:
        _height, rating_source, rating_rows, rating = best_rating
    position = select_position_glyphs(rating_rows, rating, box)
    crops = {}
    if name_row:
        spaced = render_glyphs(mask, name_row['glyphs'], 64, 0.28)
        image = with_prefix(spaced, 'NAME') if spaced is not None else name_image(mask, name_row)
        if image is not None:
            crops['name'] = save_crop(image, crop_dir, stem, 'name')
    if rating:
        rendered = render_glyphs(rating_source, rating, 64, 0.2)
        if rendered is not None:
            crops['rating'] = save_crop(with_prefix(rendered, 'OVR'), crop_dir, stem, 'rating')
    if position:
        rendered = render_glyphs(rating_source, position, 56, 0.22)
        if rendered is not None:
            crops['position'] = save_crop(with_prefix(rendered, 'POS'), crop_dir, stem, 'position')
    position_art = color_position_crop(rgb, rating)
    if position_art is not None:
        crops['positioncolor'] = save_crop(position_art, crop_dir, stem, 'positioncolor')
    for index, cell in enumerate(stat_cells(closed, box, name_row)):
        image = color_stat_cell(rgb, cell)
        if image is not None:
            crops[f'stats{index}'] = save_crop(image, crop_dir, stem, f'stats{index}')
    flag_bounds = flag_crop(rgb, rating, position, box)
    nationality, nationality_confident = classify_flag(rgb, flag_bounds)
    raw = path.read_bytes()
    return {
        'stem': stem,
        'sourcePath': str(path),
        'width': int(rgb.shape[1]),
        'height': int(rgb.shape[0]),
        'sourceImageHash': hashlib.sha256(raw).hexdigest(),
        'polarity': polarity,
        'crops': crops,
        'positionHint': position_from_glyphs(rating_source, position) if position else None,
        'nationality': nationality,
        'nationalityConfident': nationality_confident,
        'flagOnCard': flag_bounds is not None,
        'crestOnCard': crest_visible(rgb, flag_bounds, box)
    }


def save_crop(image, crop_dir, stem, kind):
    name = f'{stem}_{kind}.png'
    image.save(crop_dir / name)
    return name


def run_ocr(crop_dir, out_file):
    subprocess.run(
        [
            'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', str(OCR_SCRIPT),
            '-CropDir', str(crop_dir),
            '-OutFile', str(out_file)
        ],
        check=True,
        cwd=str(ROOT)
    )


def load_ocr(path):
    found = {}
    if not path.exists():
        return found
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        found[row.get('file') or ''] = row
    return found


def clean_letters(text):
    text = str(text or '').upper()
    text = text.replace('QQ', ' ')
    text = re.sub(r'[^A-Z \'-]+', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def display_name(ocr_name):
    parts = []
    for token in ocr_name.split(' '):
        if token in SMALL_WORDS:
            parts.append(token.capitalize())
        else:
            parts.append(token[:1] + token[1:].lower())
    return ' '.join(parts)


def name_from_ocr(text):
    """Accept a name only when the crop reads as clean capital letters.

    Windows OCR mixes in stat lines, digits and stray marks when it is unsure.
    Those strings are kept for the audit and are not used as a player's name.
    """
    raw = str(text or '').replace('QQ', '')
    raw = re.sub(r'(?i)^name', '', raw).strip(" \t-_'\"")
    if not raw or re.search(r'\d', raw):
        return None, None, False
    if not re.fullmatch(r"[A-ZÀ-ÖØ-ÞŒ]+(?:[ '\-][A-ZÀ-ÖØ-ÞŒ]+)*", raw):
        return None, None, False
    letters = re.sub(r'[^A-ZÀ-ÖØ-ÞŒ]', '', raw)
    if len(letters) < 3 or len(letters) > 28:
        return None, None, False
    tokens = [token for token in re.split(r"[ '\-]+", raw) if token]
    blocked = set(ROLES) | set(OUTFIELD_LABELS) | set(KEEPER_LABELS)
    if any(len(token) < 2 or token in blocked for token in tokens):
        return None, None, False
    cleaned = ' '.join(tokens)
    return cleaned, display_name(cleaned), True


def rating_from_ocr(text):
    raw = re.sub(r'[^A-Z0-9]', '', str(text or '').upper())
    if raw.startswith('QQ'):
        raw = raw[2:]
    digits = re.findall(r'\d', raw)
    if len(digits) != 2:
        return None, False
    value = int(''.join(digits))
    if value < 1 or value > 99:
        return None, False
    return value, True


def letter_templates():
    if getattr(letter_templates, 'cache', None) is None:
        import image_card_read as card_read
        folder = Path(__file__).resolve().parent / 'glyph-templates' / 'letters'
        found = []
        for picture in sorted(folder.glob('*.png')):
            found.append({'label': picture.stem[0], 'vec': card_read.load_picture_template(picture, (20, 16))})
        letter_templates.cache = found
    return letter_templates.cache


def position_from_glyphs(mask, glyphs):
    import image_card_read as card_read
    templates = letter_templates()
    if not glyphs or not templates:
        return None
    letters = []
    distances = []
    for glyph in glyphs:
        patch = mask[glyph[1]:glyph[3], glyph[0]:glyph[2]]
        vec = card_read.normalize(patch, (20, 16))
        if vec is None:
            return None
        label, distance = card_read.classify(vec, templates, 0.2, 0.015)
        if not label or distance is None:
            return None
        letters.append(label)
        distances.append(distance)
    role = ''.join(letters)
    if role in ROLES and sum(distances) / len(distances) <= 0.16:
        return role
    return None


def position_from_ocr(text):
    raw = re.sub(r'[^A-Z]', '', str(text or '').upper())
    for prefix in ('POSITION', 'OVR', 'POS', 'QQ'):
        if raw.startswith(prefix) and len(raw) > len(prefix):
            raw = raw[len(prefix):]
            break
    for role in ROLES:
        if raw == role:
            return role, True
    if 2 <= len(raw) <= 5:
        found = [role for role in ROLES if role in raw]
        if found:
            found.sort(key=lambda role: raw.rfind(role))
            return found[-1], True
    return None, False


def parse_stat_text(text, line_count, rendered_lines):
    outfield = {key: None for key in OUTFIELD_LABELS.values()}
    keeper = {key: None for key in ('diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning')}
    labels_found = []
    tokens = re.findall(r'[A-Z]{3}|\d{1,2}', str(text or '').upper().replace('QQ', ' '))
    for index, token in enumerate(tokens):
        if token.isdigit() or index == 0:
            continue
        label = OUTFIELD_LABELS.get(token) or KEEPER_LABELS.get(token)
        if not label:
            continue
        number = tokens[index - 1]
        if not number.isdigit():
            continue
        value = int(number)
        if value < 1 or value > 99:
            continue
        if label in outfield:
            outfield[label] = value
        else:
            keeper[label] = value
        labels_found.append(token)
    use_keeper = sum(value is not None for value in keeper.values()) > sum(value is not None for value in outfield.values())
    aligned = line_count == rendered_lines and rendered_lines >= 4
    if aligned:
        lines = [part.strip() for part in str(text or '').splitlines() if part.strip()]
        # The OCR payload usually arrives already joined. Alignment is applied by the caller
        # when the original line list is available.
    return outfield, keeper, use_keeper, labels_found


def apply_stat_lines(lines, geometry=GEOM_OUT):
    outfield = {key: None for key in OUTFIELD_LABELS.values()}
    keeper = {key: None for key in ('diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning')}
    conflicts = 0
    parsed = []
    for index, line in enumerate(lines):
        cleaned = str(line or '').upper().replace('STAT', ' ')
        label_token = next((token for token in re.findall(r'[A-Z]{3}', cleaned) if token in OUTFIELD_LABELS or token in KEEPER_LABELS), None)
        chunks = re.findall(r'\d+', cleaned)
        number = None
        if len(chunks) == 1 and chunks[0].startswith('1') and len(chunks[0]) == 3:
            number = int(chunks[0][1:])
        elif len(chunks) == 1 and len(chunks[0]) <= 2:
            number = int(chunks[0])
        if number is not None and not 1 <= number <= 99:
            number = None
        parsed.append((label_token, number))
        if label_token and number is not None:
            key = OUTFIELD_LABELS.get(label_token) or KEEPER_LABELS.get(label_token)
            target = keeper if label_token in KEEPER_LABELS else outfield
            target[key] = number
            if geometry == GEOM_OUT and index < len(geometry) and label_token in OUTFIELD_LABELS:
                if OUTFIELD_LABELS[label_token] != geometry[index]:
                    conflicts += 1
    for index, (label_token, number) in enumerate(parsed):
        if number is None or label_token is not None or index >= len(geometry):
            continue
        key = geometry[index]
        target = keeper if key in keeper else outfield
        if target.get(key) is None:
            target[key] = number
    return outfield, keeper, conflicts


def interpret_item(item, ocr):
    name_row = ocr.get(item['crops'].get('name') or '', {})
    rating_row = ocr.get(item['crops'].get('rating') or '', {})
    position_row = ocr.get(item['crops'].get('position') or '', {})
    ocr_name, display, name_confident = name_from_ocr(name_row.get('text') or '')
    overall, overall_confident = rating_from_ocr(rating_row.get('text') or '')
    position, position_confident = position_from_ocr(position_row.get('text') or '')
    if not position_confident and item.get('positionHint') in ROLES:
        position = item['positionHint']
        position_confident = True
    if not position_confident:
        colour_row = ocr.get(item['crops'].get('positioncolor') or '', {})
        position, position_confident = position_from_ocr(colour_row.get('text') or '')
    stat_lines = []
    for index in range(6):
        stat_row = ocr.get(item['crops'].get(f'stats{index}') or '', {})
        if item['crops'].get(f'stats{index}'):
            stat_lines.append(stat_row.get('text') or '')
    geometry = GEOM_GK if position == 'GK' else GEOM_OUT
    outfield, keeper, conflicts = apply_stat_lines(stat_lines, geometry if len(stat_lines) == 6 else ())
    if position != 'GK' and sum(value is not None for value in keeper.values()) >= 2:
        outfield, keeper, conflicts = apply_stat_lines(stat_lines, GEOM_GK if len(stat_lines) == 6 else ())
    use_keeper = position == 'GK' or sum(value is not None for value in keeper.values()) > sum(value is not None for value in outfield.values())
    if use_keeper and position_confident and position != 'GK':
        use_keeper = sum(value is not None for value in keeper.values()) >= 4
    attributes = keeper if use_keeper else outfield
    present = sum(value is not None for value in attributes.values())
    attributes_confident = present >= 6 and conflicts == 0
    review = []
    if not name_confident:
        review.append('The printed name could not be read confidently.')
    if not overall_confident:
        review.append('The overall rating could not be read confidently.')
    if not position_confident:
        review.append('The position could not be read confidently.')
    if not attributes_confident:
        review.append('The attribute block was not read in full.')
    stat_errors = [
        ocr.get(item['crops'].get(f'stats{index}') or '', {}).get('error')
        for index in range(6)
        if item['crops'].get(f'stats{index}')
    ]
    if any(row.get('error') for row in (name_row, rating_row, position_row)) or any(stat_errors):
        review.append('Windows OCR failed on one of the card regions.')
    return {
        'sourcePath': item['sourcePath'],
        'sourceImageHash': item['sourceImageHash'],
        'width': item['width'],
        'height': item['height'],
        'polarity': item['polarity'],
        'ocrName': ocr_name if name_confident else None,
        'displayName': display if name_confident else None,
        'nameConfident': name_confident,
        'overall': overall if overall_confident else None,
        'overallConfident': overall_confident,
        'position': position if position_confident else None,
        'positionConfident': position_confident,
        'alternatePositions': [],
        'nationality': item.get('nationality') if item.get('nationalityConfident') else None,
        'nationalityConfident': bool(item.get('nationalityConfident')),
        'flagOnCard': bool(item.get('flagOnCard')),
        'club': None,
        'clubConfident': False,
        'crestOnCard': bool(item.get('crestOnCard')),
        'pace': None if use_keeper else outfield.get('pace'),
        'shooting': None if use_keeper else outfield.get('shooting'),
        'passing': None if use_keeper else outfield.get('passing'),
        'dribbling': None if use_keeper else outfield.get('dribbling'),
        'defending': None if use_keeper else outfield.get('defending'),
        'physical': None if use_keeper else outfield.get('physical'),
        'goalkeeperAttributes': keeper if use_keeper and present else None,
        'attributesConfident': attributes_confident,
        'reviewReasons': review,
        'rawOcr': {
            'name': name_row.get('text') or '',
            'rating': rating_row.get('text') or '',
            'position': position_row.get('text') or '',
            'stats': stat_lines
        }
    }


def prepare_many(entries, crop_dir):
    crop_dir.mkdir(parents=True, exist_ok=True)
    items = []
    for index, entry in enumerate(entries, start=1):
        stem = f'{index:05d}'
        path = Path(entry['path'])
        try:
            item = prepare_card(path, crop_dir, stem)
        except Exception as error:
            item = {
                'stem': stem,
                'sourcePath': str(path),
                'sourceImageHash': None,
                'width': 0,
                'height': 0,
                'polarity': None,
                'crops': {},
                'nationality': None,
                'nationalityConfident': False,
                'flagOnCard': False,
                'crestOnCard': False,
                'prepareError': str(error)
            }
            print(f'skip {path.name}: {error}', file=sys.stderr)
        item['playerId'] = entry.get('id')
        items.append(item)
        if index % 100 == 0:
            print(f'prepared {index}/{len(entries)}', file=sys.stderr)
    return {'items': items}


def interpret_many(manifest, ocr_path):
    ocr = load_ocr(ocr_path)
    readings = []
    for item in manifest['items']:
        if item.get('prepareError'):
            readings.append({
                'playerId': item.get('playerId'),
                'sourcePath': item.get('sourcePath'),
                'nameConfident': False,
                'overallConfident': False,
                'positionConfident': False,
                'nationalityConfident': False,
                'attributesConfident': False,
                'reviewReasons': [item['prepareError']],
                'readError': item['prepareError']
            })
            continue
        reading = interpret_item(item, ocr)
        reading['playerId'] = item.get('playerId')
        readings.append(reading)
    return readings


def read_entries(entries):
    with tempfile.TemporaryDirectory(prefix='draft11-card-ocr-') as temp:
        root = Path(temp)
        crop_dir = root / 'crops'
        manifest = prepare_many(entries, crop_dir)
        ocr_path = root / 'ocr.jsonl'
        if any(item.get('crops') for item in manifest['items']):
            run_ocr(crop_dir, ocr_path)
        return interpret_many(manifest, ocr_path)


def run_catalogue():
    """Read every selected catalogue image and write the pixel readings beside the store."""
    import shutil
    from datetime import datetime, timezone

    store_path = ROOT / 'data' / 'local-catalogue' / 'catalogue.json'
    public_dir = ROOT / 'frontend' / 'public' / 'player-cards'
    out_dir = store_path.parent
    store = json.loads(store_path.read_text(encoding='utf-8'))
    names = {player.get('playerId'): player.get('name') for player in store.get('players') or []}
    entries = []
    missing_files = []
    for card in store.get('cards') or []:
        if card.get('isPrimary') is False:
            continue
        filename = Path(str(card.get('imagePath') or '')).name
        image = public_dir / filename
        if not filename or not image.exists():
            missing_files.append(card.get('playerId'))
            continue
        entries.append({'id': card.get('playerId'), 'path': str(image)})
    crop_dir = out_dir / 'card-crops'
    if crop_dir.exists():
        shutil.rmtree(crop_dir)
    manifest = prepare_many(entries, crop_dir)
    ocr_path = out_dir / 'card-ocr.jsonl'
    if any(item.get('crops') for item in manifest['items']):
        run_ocr(crop_dir, ocr_path)
    readings = interpret_many(manifest, ocr_path)
    for reading in readings:
        reading['previousCatalogueName'] = names.get(reading.get('playerId'))
    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': 'card-pixels',
        'imageCount': len(entries),
        'readings': readings
    }
    readings_path = out_dir / 'card-readings.json'
    readings_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
    audit = summarise_readings(readings, missing_files)
    (out_dir / 'card-ocr-audit.json').write_text(json.dumps(audit, indent=2), encoding='utf-8')
    shutil.rmtree(crop_dir, ignore_errors=True)
    print(json.dumps({
        'processed': audit['totalImagesProcessed'],
        'names': audit['namesExtracted'],
        'ratings': audit['ratingsExtracted'],
        'positions': audit['positionsExtracted'],
        'out': str(readings_path)
    }))


def summarise_readings(readings, missing_files):
    def count(key):
        return sum(1 for reading in readings if reading.get(key))

    def example(reading):
        return {
            'playerId': reading.get('playerId'),
            'before': {'name': reading.get('previousCatalogueName')},
            'after': {
                'name': reading.get('displayName'),
                'overall': reading.get('overall'),
                'position': reading.get('position'),
                'nationality': reading.get('nationality'),
                'pace': reading.get('pace'),
                'shooting': reading.get('shooting'),
                'passing': reading.get('passing'),
                'dribbling': reading.get('dribbling'),
                'defending': reading.get('defending'),
                'physical': reading.get('physical'),
                'goalkeeperAttributes': reading.get('goalkeeperAttributes')
            },
            'nameConfident': bool(reading.get('nameConfident'))
        }

    examples = []
    featured = next((reading for reading in readings if reading.get('playerId') == 'fut23_fts'), None)
    if featured:
        examples.append(example(featured))
    for reading in readings:
        if reading is featured:
            continue
        previous = str(reading.get('previousCatalogueName') or '')
        printed = str(reading.get('displayName') or '')
        if reading.get('nameConfident') and printed and previous.lower() != printed.lower():
            examples.append(example(reading))
        if len(examples) >= 8:
            break
    romagnoli = next((reading for reading in readings if reading.get('playerId') == 'fut23_fts'), None)
    return {
        'totalImagesProcessed': len(readings),
        'missingImageFiles': missing_files,
        'namesExtracted': count('nameConfident'),
        'ratingsExtracted': count('overallConfident'),
        'positionsExtracted': count('positionConfident'),
        'nationalitiesIdentifiedFromFlags': count('nationalityConfident'),
        'clubsIdentified': count('clubConfident'),
        'crestsVisibleWithoutAClubName': count('crestOnCard'),
        'flagsVisible': count('flagOnCard'),
        'attributeSetsExtracted': count('attributesConfident'),
        'imageToRecordMismatches': sum(
            1 for reading in readings
            if reading.get('nameConfident') and reading.get('displayName')
            and str(reading.get('previousCatalogueName') or '').lower() != str(reading.get('displayName')).lower()
        ),
        'recordsNeedingManualReview': sum(1 for reading in readings if reading.get('reviewReasons')),
        'ocrFailures': sum(1 for reading in readings if reading.get('readError') or not reading.get('nameConfident')),
        'clubNote': 'This project has no crest-to-club map. A visible crest is recorded, and no club name is invented.',
        'romagnoli': None if romagnoli is None else {
            'playerId': romagnoli.get('playerId'),
            'name': romagnoli.get('displayName'),
            'overall': romagnoli.get('overall'),
            'position': romagnoli.get('position'),
            'nationality': romagnoli.get('nationality'),
            'attributes': [
                romagnoli.get('pace'), romagnoli.get('shooting'), romagnoli.get('passing'),
                romagnoli.get('dribbling'), romagnoli.get('defending'), romagnoli.get('physical')
            ]
        },
        'examples': examples[:12]
    }


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'read':
        image = None
        player_id = None
        args = sys.argv[2:]
        for index, arg in enumerate(args):
            if arg == '--image':
                image = args[index + 1]
            if arg == '--id':
                player_id = args[index + 1]
        if not image:
            raise SystemExit('Pass --image.')
        readings = read_entries([{'id': player_id, 'path': image}])
        print(json.dumps(readings[0], indent=2))
        return
    if command == 'prepare':
        list_path = Path(sys.argv[sys.argv.index('--list') + 1])
        crop_dir = Path(sys.argv[sys.argv.index('--crops') + 1])
        manifest_path = Path(sys.argv[sys.argv.index('--manifest') + 1])
        entries = json.loads(list_path.read_text(encoding='utf-8'))
        manifest = prepare_many(entries, crop_dir)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        print(json.dumps({'prepared': len(manifest['items']), 'manifest': str(manifest_path)}))
        return
    if command == 'interpret':
        manifest_path = Path(sys.argv[sys.argv.index('--manifest') + 1])
        ocr_path = Path(sys.argv[sys.argv.index('--ocr') + 1])
        out_path = Path(sys.argv[sys.argv.index('--out') + 1])
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        readings = interpret_many(manifest, ocr_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(readings), encoding='utf-8')
        confident = sum(1 for reading in readings if reading.get('nameConfident'))
        print(json.dumps({'readings': len(readings), 'names': confident, 'out': str(out_path)}))
        return
    if command == 'catalogue':
        run_catalogue()
        return
    raise SystemExit('Use read, prepare, interpret, or catalogue.')


if __name__ == '__main__':
    main()
