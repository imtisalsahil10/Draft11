"""Second pass for card fields the first pixel reading left empty.

Confident values, record ids, the original OCR payload, and the selected
image are left untouched. A field stays null when this pass cannot read it.
Club names are never invented from a crest.
"""

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy import ndimage

import image_card_ocr as ocr

ROOT = ocr.ROOT
READINGS_PATH = ROOT / 'data' / 'local-catalogue' / 'card-readings.json'
AUDIT_PATH = ROOT / 'data' / 'local-catalogue' / 'card-ocr-audit.json'
OUTFIELD = ('pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical')
KEEPER = ('diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning')
LABELS = {
    'PAC': 'pace',
    'SHO': 'shooting',
    'PAS': 'passing',
    'DRI': 'dribbling',
    'DRU': 'dribbling',
    'DEF': 'defending',
    'PHY': 'physical',
    'PHV': 'physical',
    'DIV': 'diving',
    'HAN': 'handling',
    'KIC': 'kicking',
    'REF': 'reflexes',
    'SPE': 'speed',
    'POS': 'positioning',
}
CORE_REASONS = {
    'The printed name could not be read confidently.',
    'The overall rating could not be read confidently.',
    'The position could not be read confidently.',
    'The attribute block was not read in full.',
    'Windows OCR failed on one of the card regions.',
}


def contrast_masks(rgb, alpha):
    """Lettering that is neither near-white nor near-black still has a local edge."""
    luminance = (0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]).astype(np.float32)
    background = ndimage.uniform_filter(luminance, size=27)
    delta = luminance - background
    visible = alpha > 16
    light = visible & (delta > 18) & (luminance > 110)
    dark = visible & (delta < -18) & (luminance < 200)
    return light, dark


def needs_work(reading):
    if not reading.get('nameConfident'):
        return True
    if not reading.get('overallConfident'):
        return True
    if not reading.get('positionConfident'):
        return True
    if not reading.get('nationalityConfident'):
        return True
    if not reading.get('attributesConfident'):
        return True
    return False


def label_in(text):
    letters = re.sub(r'[^A-Z]', '', str(text or '').upper().replace('0', 'O'))
    found = [token for token in LABELS if token in letters]
    if len(found) != 1:
        return None
    return found[0]


def number_before_label(text, label):
    raw = str(text or '').upper()
    folded = raw.replace('0', 'O')
    # SH0 is a label, so the digits are searched in the original text.
    at = folded.find(label if label != 'SHO' else 'SHO')
    if label == 'SHO' and at < 0:
        at = folded.find('SHO')
    if at < 0:
        at = len(raw)
    window = raw[:at]
    chunks = re.findall(r'\d+', window)
    if not chunks:
        return None
    token = chunks[-1]
    if len(token) == 3 and token.startswith('1'):
        token = token[1:]
    if len(token) > 2:
        return None
    value = int(token)
    if 1 <= value <= 99:
        return value
    return None


def salvage_stats(lines):
    outfield = {key: None for key in OUTFIELD}
    keeper = {key: None for key in KEEPER}
    for line in lines or []:
        label = label_in(line)
        if not label:
            continue
        value = labeled_stat_number(line, label)
        if value is None:
            continue
        key = LABELS[label]
        if key in outfield and outfield[key] is None:
            outfield[key] = value
        elif key in keeper and keeper[key] is None:
            keeper[key] = value
    return outfield, keeper


def apply_salvage(reading):
    """Fill empty fields from the original OCR text when the text is unambiguous."""
    filled = []
    if not reading.get('attributesConfident'):
        outfield, keeper = salvage_stats((reading.get('rawOcr') or {}).get('stats') or [])
        for key, value in outfield.items():
            if reading.get(key) is None and value is not None:
                reading[key] = value
                filled.append(key)
        current = reading.get('goalkeeperAttributes')
        if not isinstance(current, dict):
            current = {}
        changed = False
        for key, value in keeper.items():
            if current.get(key) is None and value is not None:
                current[key] = value
                changed = True
                filled.append(key)
        if changed:
            reading['goalkeeperAttributes'] = current
    if filled:
        reading['recovery'] = {
            'filled': filled,
            'source': 'original-ocr-text',
        }
    refresh_review(reading)
    return reading


def refresh_review(reading):
    kept = [reason for reason in (reading.get('reviewReasons') or []) if reason not in CORE_REASONS]
    if not reading.get('nameConfident'):
        kept.append('The printed name could not be read confidently.')
    if not reading.get('overallConfident'):
        kept.append('The overall rating could not be read confidently.')
    if not reading.get('positionConfident'):
        kept.append('The position could not be read confidently.')
    if not reading.get('attributesConfident'):
        reading['attributesConfident'] = attributes_complete(reading)
    if not reading.get('attributesConfident'):
        kept.append('The attribute block was not read in full.')
    reading['reviewReasons'] = kept


def attributes_complete(reading):
    keeper = reading.get('goalkeeperAttributes') if isinstance(reading.get('goalkeeperAttributes'), dict) else {}
    keeper_count = sum(isinstance(keeper.get(key), int) for key in KEEPER)
    out_count = sum(isinstance(reading.get(key), int) for key in OUTFIELD)
    if reading.get('position') == 'GK':
        return keeper_count == 6
    if out_count == 6 and keeper_count == 0:
        return True
    if keeper_count == 6 and out_count == 0:
        return True
    return False


def name_candidate(mask, box):
    card_w, card_h = ocr.content_size(box)
    zone = (
        box[0] + int(card_w * 0.14),
        box[1] + int(card_h * 0.54),
        box[0] + int(card_w * 0.90),
        box[1] + int(card_h * 0.72),
    )
    glyphs = ocr.components(
        ocr.close_vertical(mask),
        zone,
        max(8, int(card_h * 0.028)),
        int(card_h * 0.095),
    )
    best = None
    for row in ocr.cluster_rows(glyphs, 0.5):
        for run in ocr.contiguous_runs(row['glyphs'], row['h']):
            if not 3 <= len(run) <= 16:
                continue
            x0 = min(glyph[0] for glyph in run)
            x1 = max(glyph[2] for glyph in run)
            center = ((x0 + x1) / 2 - box[0]) / card_w
            width = x1 - x0
            if not 0.36 <= center <= 0.68 or width < card_w * 0.12:
                continue
            score = width + row['h'] * 3
            if best is None or score > best[0]:
                best = (score, run, row['h'])
    if best is None:
        return None
    _score, run, height = best
    return render_name(mask, run, height)


def render_name(mask, glyphs, height):
    parts = []
    gaps = []
    ordered = sorted(glyphs, key=lambda glyph: glyph[0])
    for glyph in ordered:
        part = ocr.render_mask(mask[glyph[1]:glyph[3], glyph[0]:glyph[2]], 72)
        if part is not None:
            parts.append(part)
    if len(parts) < 3:
        return None
    for left, right in zip(ordered, ordered[1:]):
        gaps.append(right[0] - left[2])
    limit = max(8, height * 0.55)
    images = []
    cursor_parts = parts
    # A wide gap is a space between words. Keep it wide enough for OCR to see.
    gap_px = []
    usable = gaps[:len(parts) - 1]
    for gap in usable:
        gap_px.append(int(72 * (0.7 if gap > limit else 0.2)))
    width = sum(part.width for part in cursor_parts) + sum(gap_px)
    canvas = __import__('PIL').Image.new('L', (width, 72), 255)
    cursor = 0
    for index, part in enumerate(cursor_parts):
        canvas.paste(part, (cursor, 0))
        cursor += part.width + (gap_px[index] if index < len(gap_px) else 0)
    return ocr.with_prefix(canvas, 'NAME')


def rating_pair(mask, box):
    card_w, card_h = ocr.content_size(box)
    zone = (
        box[0] + int(card_w * 0.02),
        box[1] + int(card_h * 0.01),
        box[0] + int(card_w * 0.40),
        box[1] + int(card_h * 0.30),
    )
    closed = ndimage.binary_closing(mask, structure=np.ones((3, 3), dtype=bool))
    glyphs = ocr.components(closed, zone, max(10, int(card_h * 0.045)), int(card_h * 0.16))
    rows = ocr.cluster_rows(glyphs, 0.4)
    pair = ocr.select_rating_row(rows, box)
    if not pair:
        return None
    top = min(pair[0][1], pair[1][1])
    if (top - box[1]) / card_h > 0.24:
        return None
    return pair


def rating_image(mask, pair):
    rendered = ocr.render_glyphs(mask, pair, 80, 0.16)
    if rendered is None:
        return None
    return ocr.with_prefix(rendered, 'OVR')


def position_letter_templates():
    if getattr(position_letter_templates, 'cache', None) is None:
        import image_card_read as card_read
        _digits, letters = card_read.load_templates(ROOT / 'frontend' / 'public' / 'player-cards')
        position_letter_templates.cache = letters
    return position_letter_templates.cache


def position_from_templates(mask, pair):
    """The position alphabet is small enough to match against the glyph templates on disk."""
    if not pair:
        return None
    templates = position_letter_templates()
    if not templates:
        return None
    import image_card_read as card_read
    left, right = pair
    rating_h = max(ocr.glyph_h(left), ocr.glyph_h(right))
    x0 = max(0, min(left[0], right[0]) - 2)
    x1 = min(mask.shape[1], max(left[2], right[2]) + 4)
    y0 = max(left[3], right[3]) + 1
    y1 = min(mask.shape[0], y0 + max(12, int(rating_h * 0.72)))
    if y1 - y0 < 8 or x1 - x0 < 8:
        return None
    band = mask[y0:y1, x0:x1]
    labels, _count = ndimage.label(band)
    glyphs = []
    for index, slc in enumerate(ndimage.find_objects(labels), start=1):
        if slc is None:
            continue
        patch = labels[slc] == index
        if int(patch.sum()) < 8:
            continue
        height = slc[0].stop - slc[0].start
        width = slc[1].stop - slc[1].start
        if height < 6:
            continue
        vector = card_read.normalize(patch, (20, 16))
        if vector is None:
            continue
        label, distance = card_read.classify(vector, templates, 0.30, 0.012)
        if not label or distance is None:
            continue
        glyphs.append((slc[1].start, slc[1].stop, height, label, distance))
    if len(glyphs) < 2:
        return None
    tallest = max(item[2] for item in glyphs)
    glyphs = [item for item in glyphs if item[2] >= tallest * 0.7]
    glyphs.sort()
    run = [glyphs[0]]
    for item in glyphs[1:]:
        if item[0] - run[-1][1] > tallest * 0.85:
            break
        run.append(item)
    if not 2 <= len(run) <= 3:
        return None
    role = ''.join(item[3] for item in run)
    if role in ocr.ROLES:
        return role
    return None


def position_image(mask, pair):
    """Read the letters directly under the rating from the same ink that formed the digits."""
    if not pair:
        return None
    left, right = pair
    rating_h = max(ocr.glyph_h(left), ocr.glyph_h(right))
    x0 = max(0, min(left[0], right[0]) - 2)
    x1 = min(mask.shape[1], max(left[2], right[2]) + 4)
    y0 = max(left[3], right[3]) + 1
    y1 = min(mask.shape[0], y0 + max(12, int(rating_h * 0.72)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    rendered = ocr.render_mask(mask[y0:y1, x0:x1], 64)
    if rendered is None or rendered.width < 12:
        return None
    return ocr.with_prefix(rendered, 'POS')


def stat_images(rgb, mask, box):
    card_w, card_h = ocr.content_size(box)
    zone = (
        box[0] + int(card_w * 0.08),
        box[1] + int(card_h * 0.66),
        box[0] + int(card_w * 0.98),
        box[1] + int(card_h * 0.97),
    )
    glyphs = ocr.components(
        ocr.close_vertical(mask),
        zone,
        max(7, int(card_h * 0.025)),
        int(card_h * 0.08),
    )
    rows = []
    for row in ocr.cluster_rows(glyphs, 0.5):
        left = []
        right = []
        middle = box[0] + card_w * 0.52
        for run in ocr.contiguous_runs(row['glyphs'], row['h']):
            if len(run) < 4:
                continue
            center = (min(glyph[0] for glyph in run) + max(glyph[2] for glyph in run)) / 2
            if center < middle:
                left.append(run)
            else:
                right.append(run)
        if not left or not right:
            continue
        left.sort(key=lambda run: sum(ocr.glyph_w(glyph) for glyph in run), reverse=True)
        right.sort(key=lambda run: sum(ocr.glyph_w(glyph) for glyph in run), reverse=True)
        rows.append((row['cy'], left[0], right[0]))
    rows.sort(key=lambda item: item[0])
    images = []
    for _cy, left, right in rows[:3]:
        for run in (left, right):
            image = ocr.color_stat_cell(rgb, run)
            if image is not None:
                images.append(image)
    return images if len(images) >= 4 else []


def colour_fractions(crop):
    if crop.size == 0:
        return {}
    counts = {}
    pixels = crop.reshape(-1, 3)
    step = max(1, len(pixels) // 800)
    total = 0
    for pixel in pixels[::step]:
        bucket = ocr.colour_bucket(pixel)
        counts[bucket] = counts.get(bucket, 0) + 1
        total += 1
    if not total:
        return {}
    return {key: value / total for key, value in counts.items()}


def best_flag_bounds(rgb, pair, box):
    if not pair:
        return None
    left, right = pair
    card_w, card_h = ocr.content_size(box)
    anchor_y = max(left[3], right[3]) + int(card_h * 0.055)
    center = (min(left[0], right[0]) + max(left[2], right[2])) / 2
    width = max(int(card_w * 0.13), int((max(left[2], right[2]) - min(left[0], right[0])) * 1.35))
    height = max(12, int(width * 0.64))
    best = None
    best_score = 0
    for y0 in range(int(anchor_y), int(anchor_y + card_h * 0.12), 2):
        x0 = int(center - width / 2)
        sx0 = max(box[0], x0)
        sx1 = min(box[2], x0 + width)
        sy1 = min(box[3], y0 + height)
        if sy1 - y0 < height * 0.75 or sx1 - sx0 < width * 0.7:
            continue
        crop = ocr.trim_dark_margins(rgb[y0:sy1, sx0:sx1])
        fractions = colour_fractions(crop)
        distinct = sum(1 for key, share in fractions.items() if key not in {'gray', 'black', 'cyan', 'purple'} and share > 0.12)
        score = ocr.colourfulness(crop) * max(distinct, 1)
        if distinct >= 2:
            score += 15
        if score > best_score:
            best_score = score
            best = (sx0, y0, sx1, min(box[3], y0 + height))
    if best is None or best_score < 40:
        return None
    return best


def classify_visible_flag(rgb, bounds):
    """Use the existing flag table. An unrecognised flag stays blank."""
    if not bounds:
        return None
    nation, confident = ocr.classify_flag(rgb, bounds)
    if confident and nation:
        return nation
    return None


def prepare_recovery(path, needed):
    rgb, alpha, box = ocr.load_card(path)
    contrast_light, contrast_dark = contrast_masks(rgb, alpha)
    ink_light, ink_dark = ocr.ink_masks(rgb, alpha)
    crops = {}
    pair = None
    pair_mask = None
    template_position = None
    best_height = -1
    for mask in (ink_light, ink_dark, contrast_light, contrast_dark):
        found = rating_pair(mask, box)
        if not found:
            continue
        height = ocr.glyph_h(found[0]) + ocr.glyph_h(found[1])
        if height <= best_height:
            continue
        best_height = height
        pair = found
        pair_mask = mask
        template_position = position_from_templates(mask, found)
    if 'rating' in needed and pair is not None:
        image = rating_image(pair_mask, pair)
        if image is not None:
            crops['rating'] = image
    if 'position' in needed and pair is not None:
        image = position_image(pair_mask, pair)
        if image is not None:
            crops['position'] = image
    if 'name' in needed:
        best = None
        for mask in (contrast_light, contrast_dark):
            image = name_candidate(mask, box)
            if image is not None and (best is None or image.width > best.width):
                best = image
        if best is not None:
            crops['name'] = best
    if 'stats' in needed:
        best_stats = []
        for mask in (contrast_light, contrast_dark):
            images = stat_images(rgb, mask, box)
            if len(images) > len(best_stats):
                best_stats = images
        for index, image in enumerate(best_stats):
            crops[f'stats{index}'] = image
    nation = None
    flag_on_card = False
    if 'nationality' in needed and pair is not None:
        bounds = best_flag_bounds(rgb, pair, box)
        flag_on_card = bounds is not None
        nation = classify_visible_flag(rgb, bounds) if bounds else None
    return crops, nation, flag_on_card, template_position


def needed_fields(reading):
    needed = set()
    if not reading.get('nameConfident'):
        needed.add('name')
    if not reading.get('overallConfident'):
        needed.add('rating')
    if not reading.get('positionConfident'):
        needed.add('position')
    if not reading.get('nationalityConfident'):
        needed.add('nationality')
    if not reading.get('attributesConfident'):
        needed.add('stats')
    return needed


def rating_from_recovery(text):
    raw = re.sub(r'[^A-Z0-9]', '', str(text or '').upper())
    match = re.fullmatch(r'(?:OVR|0VR|QVR)?(\d{2})', raw)
    if match:
        value = int(match.group(1))
        if 1 <= value <= 99:
            return value
    # A broken 7 is often read as T beside a real OVR prefix.
    match = re.fullmatch(r'OVR(\d)T', raw) or re.fullmatch(r'OVRT(\d)', raw)
    if match:
        digits = match.groups()
        if raw.endswith('T') and not raw.endswith('TT'):
            value = int(digits[0]) * 10 + 7
        else:
            value = 70 + int(digits[0])
        if 1 <= value <= 99:
            return value
    return None


def interpret_recovery(ocr_rows, nation):
    found = {}
    for key, row in ocr_rows.items():
        found[key] = row.get('text') or ''
    result = {
        'ocrName': None,
        'displayName': None,
        'nameConfident': False,
        'overall': None,
        'overallConfident': False,
        'position': None,
        'positionConfident': False,
        'nationality': nation,
        'nationalityConfident': bool(nation),
        'texts': found,
    }
    if 'name' in found:
        name, display, confident = ocr.name_from_ocr(found['name'])
        if confident:
            result['ocrName'] = name
            result['displayName'] = display
            result['nameConfident'] = True
    if 'rating' in found:
        value = rating_from_recovery(found['rating'])
        if value is not None:
            result['overall'] = value
            result['overallConfident'] = True
    if 'position' in found:
        position, confident = ocr.position_from_ocr(found['position'])
        if confident and position in ocr.ROLES:
            result['position'] = position
            result['positionConfident'] = True
    lines = [found[key] for key in sorted(found) if key.startswith('stats')]
    result['outfield'], result['keeper'] = recovered_stats(lines, result.get('position'))
    return result


def bare_stat_number(text):
    raw = str(text or '').upper().replace('STAT', ' ')
    if re.search(r'[A-Z]', raw):
        return None
    chunks = re.findall(r'\d+', raw)
    if len(chunks) != 1:
        return None
    token = chunks[0]
    if len(token) == 3 and token.startswith('1'):
        token = token[1:]
    if len(token) != 2:
        return None
    value = int(token)
    if 1 <= value <= 99:
        return value
    return None


def labeled_stat_number(text, label):
    value = number_before_label(text, label)
    if value is None:
        return None
    raw = str(text or '').upper()
    chunks = re.findall(r'\d+', raw.split('STAT')[0])
    if not chunks:
        return None
    token = chunks[-1]
    if len(token) == 1:
        return None
    return value


def recovered_stats(lines, position):
    outfield = {key: None for key in OUTFIELD}
    keeper = {key: None for key in KEEPER}
    bare = []
    for line in lines:
        label = label_in(line)
        if label:
            value = labeled_stat_number(line, label)
            key = LABELS.get(label)
            if value is not None and key in outfield:
                outfield[key] = value
            elif value is not None and key in keeper:
                keeper[key] = value
            bare.append(None)
        else:
            bare.append(bare_stat_number(line))
    if len(lines) == 6:
        geometry = ocr.GEOM_GK if position == 'GK' else ocr.GEOM_OUT
        for index, value in enumerate(bare):
            if value is None:
                continue
            key = geometry[index]
            target = keeper if key in keeper else outfield
            if target.get(key) is None:
                target[key] = value
    return outfield, keeper


def merge_recovery(reading, recovered):
    """Copy a new value only into a field that is still empty."""
    filled = list((reading.get('recovery') or {}).get('filled') or [])
    if not reading.get('nameConfident') and recovered.get('nameConfident'):
        reading['ocrName'] = recovered.get('ocrName')
        reading['displayName'] = recovered.get('displayName')
        reading['nameConfident'] = True
        filled.append('name')
    if not reading.get('overallConfident') and recovered.get('overallConfident'):
        reading['overall'] = recovered.get('overall')
        reading['overallConfident'] = True
        filled.append('overall')
    if not reading.get('positionConfident') and recovered.get('positionConfident'):
        reading['position'] = recovered.get('position')
        reading['positionConfident'] = True
        filled.append('position')
    if not reading.get('nationalityConfident') and recovered.get('nationalityConfident'):
        reading['nationality'] = recovered.get('nationality')
        reading['nationalityConfident'] = True
        filled.append('nationality')
        if recovered.get('flagOnCard'):
            reading['flagOnCard'] = True
    if not reading.get('attributesConfident'):
        for key, value in (recovered.get('outfield') or {}).items():
            if reading.get(key) is None and isinstance(value, int):
                reading[key] = value
                filled.append(key)
        current = reading.get('goalkeeperAttributes')
        if not isinstance(current, dict):
            current = {}
        changed = False
        for key, value in (recovered.get('keeper') or {}).items():
            if current.get(key) is None and isinstance(value, int):
                current[key] = value
                changed = True
                filled.append(key)
        if changed or current:
            if any(isinstance(current.get(key), int) for key in KEEPER):
                reading['goalkeeperAttributes'] = current
    if filled:
        previous = reading.get('recovery') if isinstance(reading.get('recovery'), dict) else {}
        reading['recovery'] = {
            'filled': filled,
            'source': previous.get('source') or 'contrast-ocr',
            'ocr': recovered.get('texts') or previous.get('ocr'),
        }
    refresh_review(reading)
    return reading


def field_counts(readings):
    keeper_present = 0
    individual = 0
    for reading in readings:
        individual += sum(isinstance(reading.get(key), int) for key in OUTFIELD)
        keeper = reading.get('goalkeeperAttributes') if isinstance(reading.get('goalkeeperAttributes'), dict) else {}
        present = sum(isinstance(keeper.get(key), int) for key in KEEPER)
        individual += present
        if present:
            keeper_present += 1
    return {
        'names': sum(1 for reading in readings if reading.get('nameConfident')),
        'ratings': sum(1 for reading in readings if reading.get('overallConfident')),
        'positions': sum(1 for reading in readings if reading.get('positionConfident')),
        'nationalities': sum(1 for reading in readings if reading.get('nationalityConfident')),
        'attributeSets': sum(1 for reading in readings if reading.get('attributesConfident')),
        'individualAttributes': individual,
        'goalkeeperBlocks': keeper_present,
        'flagsVisible': sum(1 for reading in readings if reading.get('flagOnCard')),
    }


def missing_core(readings):
    rows = []
    for reading in readings:
        missing = []
        if not reading.get('nameConfident'):
            missing.append('name')
        if not reading.get('overallConfident'):
            missing.append('overall')
        if not reading.get('positionConfident'):
            missing.append('position')
        if missing:
            rows.append({
                'playerId': reading.get('playerId'),
                'storedName': reading.get('previousCatalogueName'),
                'missing': missing,
            })
    return rows


def recover_image(path, needed=None):
    needed = set(needed or ('name', 'rating', 'position', 'nationality', 'stats'))
    crops, nation, flag_on_card, template_position = prepare_recovery(Path(path), needed)
    rows = {}
    if any(key != 'nationality' for key in crops):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='draft11-recover-') as temp:
            crop_dir = Path(temp)
            manifest = {}
            for key, image in crops.items():
                filename = f'00001_{key}.png'
                image.save(crop_dir / filename)
                manifest[key] = filename
            ocr_path = crop_dir / 'ocr.jsonl'
            ocr.run_ocr(crop_dir, ocr_path)
            loaded = ocr.load_ocr(ocr_path)
            rows = {key: loaded.get(filename, {}) for key, filename in manifest.items()}
    recovered = interpret_recovery(rows, nation)
    recovered['flagOnCard'] = flag_on_card
    if not recovered.get('positionConfident') and template_position in ocr.ROLES:
        recovered['position'] = template_position
        recovered['positionConfident'] = True
    return recovered


def run_recovery(limit_ids=None, write=True):
    payload = json.loads(READINGS_PATH.read_text(encoding='utf-8'))
    readings = payload['readings']
    before = field_counts(readings)
    targets = []
    for reading in readings:
        if limit_ids is not None and reading.get('playerId') not in limit_ids:
            continue
        if needs_work(reading):
            targets.append(reading)
    print(f'recovery targets {len(targets)}', flush=True)
    import tempfile
    with tempfile.TemporaryDirectory(prefix='draft11-recover-') as temp:
        crop_dir = Path(temp) / 'crops'
        crop_dir.mkdir()
        prepared = []
        for index, reading in enumerate(targets, start=1):
            path = Path(reading.get('sourcePath') or '')
            item = {
                'playerId': reading.get('playerId'),
                'crops': {},
                'nationality': None,
                'flagOnCard': False,
            }
            if path.exists():
                digest = __import__('hashlib').sha256(path.read_bytes()).hexdigest()
                if reading.get('sourceImageHash') and digest != reading['sourceImageHash']:
                    item['skipped'] = 'image-hash'
                else:
                    try:
                        crops, nation, flag_on_card, template_position = prepare_recovery(path, needed_fields(reading))
                        item['nationality'] = nation
                        item['flagOnCard'] = flag_on_card
                        item['templatePosition'] = template_position
                        for key, image in crops.items():
                            filename = f"{index:05d}_{key}.png"
                            image.save(crop_dir / filename)
                            item['crops'][key] = filename
                    except Exception as error:
                        item['error'] = str(error)
                        print(f'skip {reading.get("playerId")}: {error}', flush=True)
            else:
                item['skipped'] = 'missing-image'
            prepared.append(item)
            if index % 100 == 0:
                print(f'prepared {index}/{len(targets)}', flush=True)
        ocr_path = Path(temp) / 'ocr.jsonl'
        if any(item.get('crops') for item in prepared):
            ocr.run_ocr(crop_dir, ocr_path)
        loaded = ocr.load_ocr(ocr_path)
        for reading, item in zip(targets, prepared):
            rows = {key: loaded.get(filename, {}) for key, filename in (item.get('crops') or {}).items()}
            recovered = interpret_recovery(rows, item.get('nationality'))
            recovered['flagOnCard'] = item.get('flagOnCard')
            if not recovered.get('positionConfident') and item.get('templatePosition') in ocr.ROLES:
                recovered['position'] = item.get('templatePosition')
                recovered['positionConfident'] = True
            merge_recovery(reading, recovered)
    for reading in targets:
        apply_salvage(reading)
    after = field_counts(readings)
    romagnoli = next((reading for reading in readings if reading.get('playerId') == 'fut23_fts'), None)
    guard = {
        'displayName': None if romagnoli is None else romagnoli.get('displayName'),
        'overall': None if romagnoli is None else romagnoli.get('overall'),
        'position': None if romagnoli is None else romagnoli.get('position'),
        'nationality': None if romagnoli is None else romagnoli.get('nationality'),
        'pace': None if romagnoli is None else romagnoli.get('pace'),
        'shooting': None if romagnoli is None else romagnoli.get('shooting'),
        'passing': None if romagnoli is None else romagnoli.get('passing'),
        'dribbling': None if romagnoli is None else romagnoli.get('dribbling'),
        'defending': None if romagnoli is None else romagnoli.get('defending'),
        'physical': None if romagnoli is None else romagnoli.get('physical'),
    }
    expected = {
        'displayName': 'Romagnoli',
        'overall': 91,
        'position': 'CB',
        'nationality': 'Italy',
        'pace': 86,
        'shooting': 52,
        'passing': 72,
        'dribbling': 78,
        'defending': 93,
        'physical': 90,
    }
    if guard != expected:
        raise SystemExit(f'Romagnoli reading changed: {json.dumps(guard)}')
    remaining = missing_core(readings)
    summary = {
        'recoveryCompletedAt': datetime.now(timezone.utc).isoformat(),
        'before': before,
        'after': after,
        'remainingMissingCore': remaining,
        'remainingMissingCoreCount': len(remaining),
    }
    if write and limit_ids is None:
        backup = READINGS_PATH.with_name('card-readings.before-recovery.json')
        if not backup.exists():
            shutil.copyfile(READINGS_PATH, backup)
        payload['generatedAt'] = summary['recoveryCompletedAt']
        payload['recoveryPass'] = 'missing-fields-only'
        READINGS_PATH.write_text(json.dumps(payload, indent=2), encoding='utf-8')
        audit = {}
        if AUDIT_PATH.exists():
            audit = json.loads(AUDIT_PATH.read_text(encoding='utf-8'))
        audit.update({
            'namesExtracted': after['names'],
            'ratingsExtracted': after['ratings'],
            'positionsExtracted': after['positions'],
            'nationalitiesIdentifiedFromFlags': after['nationalities'],
            'attributeSetsExtracted': after['attributeSets'],
            'flagsVisible': after['flagsVisible'],
            'recovery': summary,
            'romagnoli': {
                'playerId': 'fut23_fts',
                'name': guard['displayName'],
                'overall': guard['overall'],
                'position': guard['position'],
                'nationality': guard['nationality'],
                'attributes': [
                    guard['pace'], guard['shooting'], guard['passing'],
                    guard['dribbling'], guard['defending'], guard['physical'],
                ],
            },
        })
        AUDIT_PATH.write_text(json.dumps(audit, indent=2), encoding='utf-8')
    print(json.dumps({'before': before, 'after': after, 'remainingCore': len(remaining)}, indent=2))
    if limit_ids is not None:
        shown = []
        for reading in readings:
            if reading.get('playerId') not in limit_ids:
                continue
            keeper = reading.get('goalkeeperAttributes') if isinstance(reading.get('goalkeeperAttributes'), dict) else None
            shown.append({
                'playerId': reading.get('playerId'),
                'displayName': reading.get('displayName'),
                'nameConfident': reading.get('nameConfident'),
                'overall': reading.get('overall'),
                'position': reading.get('position'),
                'nationality': reading.get('nationality'),
                'pace': reading.get('pace'),
                'shooting': reading.get('shooting'),
                'passing': reading.get('passing'),
                'dribbling': reading.get('dribbling'),
                'defending': reading.get('defending'),
                'physical': reading.get('physical'),
                'goalkeeperAttributes': keeper,
                'attributesConfident': reading.get('attributesConfident'),
                'recovery': reading.get('recovery'),
            })
        print(json.dumps(shown, indent=2))
    return summary


def main():
    command = __import__('sys').argv[1] if len(__import__('sys').argv) > 1 else ''
    if command == 'recover':
        run_recovery(write=True)
        return
    if command == 'sample':
        ids = set(__import__('sys').argv[2].split(','))
        run_recovery(limit_ids=ids, write=False)
        return
    if command == 'read':
        image = None
        args = __import__('sys').argv[2:]
        for index, arg in enumerate(args):
            if arg == '--image':
                image = args[index + 1]
        if not image:
            raise SystemExit('Pass --image.')
        print(json.dumps(recover_image(image), indent=2))
        return
    raise SystemExit('Use recover, sample, or read.')


if __name__ == '__main__':
    main()
