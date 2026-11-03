"""Read Draft11 player cards from the image files themselves.

Windows OCR supplies the name and the six attribute labels. The overall
rating and the position letters are classified from the light lettering on
the card. A value that is not read stays null. This script does not open the
FIFA workbook and does not rename or delete any source image.
"""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_DIR = Path(__file__).resolve().parent / 'glyph-templates'
ROLES = {
    'GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM',
    'LM', 'RM', 'LW', 'RW', 'CF', 'ST'
}
DARK_ANCHORS = {
    'fut23_fabio_cannavaro_card_03.webp': '87',
}


def dark_text_mask(image):
    arr = np.asarray(image.convert('RGB')).astype(np.int16)
    peak = arr.max(axis=2)
    cutoff = min(float(np.percentile(peak, 22)), 140)
    return peak < cutoff


ANCHORS = {
    '8': ('fut23_bruno_fernandes_primary.webp', 0),
    '8b': ('fut23_bruno_fernandes_primary.webp', 1),
    '9': ('fut23_aaron_ramsdale_primary.webp', 0),
    '0': ('fut23_aaron_ramsdale_primary.webp', 1),
    '9b': ('fut23_lionel_messi_card_08.webp', 0),
    '7': ('fut23_jan_oblak_primary.webp', 1),
    '6': ('fut23_erling_haaland_card_05.webp', 1),
    '9c': ('fut23_kylian_mbappe_primary.webp', 0),
    '7b': ('fut23_kylian_mbappe_primary.webp', 1),
}


def text_mask(image):
    arr = np.asarray(image.convert('RGB')).astype(np.int16)
    red, green, blue = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    peak = np.maximum(np.maximum(red, green), blue)
    floor = np.minimum(np.minimum(red, green), blue)
    saturation = (peak - floor) / np.maximum(peak, 1)
    return (peak > 165) & (saturation < 0.42) & (green > 140) & (blue > 90)


def normalize(patch, shape):
    ys, xs = np.nonzero(patch)
    if len(ys) == 0:
        return None
    crop = patch[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    if crop.shape[0] < 4 or crop.shape[1] < 2:
        return None
    target_h, target_w = shape
    fitted_w = max(6, min(target_w, round(crop.shape[1] * target_h / crop.shape[0])))
    resized = np.array(
        Image.fromarray(crop.astype(np.uint8) * 255).resize((fitted_w, target_h), Image.Resampling.NEAREST)
    ) > 127
    canvas = np.zeros(shape, dtype=bool)
    left = (target_w - resized.shape[1]) // 2
    canvas[:, left:left + resized.shape[1]] = resized
    return canvas


def load_picture_template(path, shape):
    image = Image.open(path).convert('L')
    # Saved cluster centers are a 4x nearest-neighbour enlargement.
    small = image.resize((shape[1], shape[0]), Image.Resampling.NEAREST)
    return np.array(small) < 128


def components(mask):
    closed = ndimage.binary_closing(mask, iterations=1)
    labels, _count = ndimage.label(closed)
    found = []
    for index, slc in enumerate(ndimage.find_objects(labels), start=1):
        if slc is None:
            continue
        patch = labels[slc] == index
        if int(patch.sum()) < 12:
            continue
        y0, y1 = slc[0].start, slc[0].stop
        x0, x1 = slc[1].start, slc[1].stop
        found.append((x0, y0, x1, y1, patch))
    return found


def split_wide(patch):
    height, width = patch.shape
    if width < height * 1.2 or width < 12:
        return [patch]
    columns = patch.sum(axis=0)
    start, end = int(width * 0.3), int(width * 0.7)
    if end <= start:
        return [patch]
    cut = start + int(np.argmin(columns[start:end]))
    if columns[cut] > height * 0.2:
        return [patch]
    parts = [patch[:, :cut], patch[:, cut:]]
    pieces = []
    for part in parts:
        if int(part.sum()) < 12:
            continue
        pieces.extend(split_wide(part))
    return pieces or [patch]


def rating_glyphs(mask):
    height, width = mask.shape
    glyphs = []
    for x0, y0, x1, y1, patch in components(mask):
        box_w, box_h = x1 - x0, y1 - y0
        if not 30 <= box_h <= 42 or not 6 <= box_w <= 26 or box_h / max(box_w, 1) < 1.35:
            continue
        if x0 < width * 0.16 or y0 < 4 or y0 > height * 0.62:
            continue
        vec = normalize(patch, (24, 20))
        if vec is not None:
            glyphs.append((box_h, y0, x0, x1, vec))
    if not glyphs:
        return []
    glyphs.sort(key=lambda item: (-item[0], item[2]))
    top_h, top_y = glyphs[0][0], glyphs[0][1]
    chosen = [item for item in glyphs if item[0] >= top_h * 0.85 and abs(item[1] - top_y) <= 8]
    chosen.sort(key=lambda item: item[2])
    return chosen[:2]


def classify(vec, templates, max_distance, margin):
    scored = []
    for item in templates:
        scored.append((float(np.mean(vec != item['vec'])), item['label']))
    scored.sort()
    if not scored:
        return None, None
    best, label = scored[0]
    second = 1
    for distance, other in scored[1:]:
        if other != label:
            second = distance
            break
    if best > max_distance or second < best + margin:
        return None, round(best, 4)
    return label, round(best, 4)


def read_rating(mask, templates):
    glyphs = rating_glyphs(mask)
    if len(glyphs) != 2:
        return None, None
    digits = []
    distances = []
    for glyph in glyphs:
        label, distance = classify(glyph[4], templates, 0.125, 0.028)
        if label is None:
            return None, distance
        digits.append(int(label))
        distances.append(distance)
    value = digits[0] * 10 + digits[1]
    if value < 1 or value > 99:
        return None, None
    return value, round(sum(distances) / 2, 4)


def letter_rows(mask, rating_box):
    height, width = mask.shape
    rows = {'main': [], 'alt': []}
    if rating_box is None:
        return rows
    _bh, top_y, left, right = rating_box
    bottom = top_y + _bh
    for x0, y0, x1, y1, patch in components(mask):
        box_h = y1 - y0
        if y0 < bottom - 8 or y0 > bottom + 26 or not 9 <= box_h <= 24:
            continue
        if x0 <= 1:
            continue
        pieces = split_wide(patch)
        cursor = x0
        for piece in pieces:
            vec = normalize(piece, (20, 16))
            if vec is None:
                continue
            piece_w = piece.shape[1]
            center = cursor + piece_w / 2
            if left - 6 <= center <= right + 14:
                rows['main'].append((y0, cursor, vec))
            elif center < left - 6:
                rows['alt'].append((y0, cursor, vec))
            cursor += piece_w
    return rows


def read_positions(mask, letter_templates):
    glyphs = rating_glyphs(mask)
    if len(glyphs) != 2:
        return None, [], None
    rating_box = (glyphs[0][0], glyphs[0][1], glyphs[0][2], glyphs[1][3])
    grouped = letter_rows(mask, rating_box)

    def lines_of(entries):
        if not entries:
            return [], []
        ordered = sorted(entries, key=lambda item: (item[0], item[1]))
        lines = [[ordered[0]]]
        for entry in ordered[1:]:
            if abs(entry[0] - lines[-1][0][0]) <= 8:
                lines[-1].append(entry)
            else:
                lines.append([entry])
        roles = []
        distances = []
        for line in lines:
            chars = []
            line_distances = []
            for _y, _x, vec in sorted(line, key=lambda item: item[1]):
                label, distance = classify(vec, letter_templates, 0.16, 0.04)
                if label is None or distance is None:
                    chars = []
                    break
                chars.append(label)
                line_distances.append(distance)
            role = ''.join(chars)
            if role in ROLES:
                roles.append(role)
                distances.append(sum(line_distances) / len(line_distances))
        return roles, distances

    main_roles, main_distances = lines_of(grouped['main'])
    alt_roles, _alt_distances = lines_of(grouped['alt'])
    position = main_roles[0] if main_roles else None
    alternates = []
    for role in alt_roles:
        if role != position and role not in alternates:
            alternates.append(role)
    distance = round(main_distances[0], 4) if main_distances else None
    return position, alternates, distance


def flag_signature(image):
    width, height = image.size
    crop = image.crop((int(width * 0.16), int(height * 0.30), int(width * 0.42), int(height * 0.44)))
    arr = np.asarray(crop.convert('RGB')).astype(np.float32)
    peak = arr.max(axis=2)
    floor = arr.min(axis=2)
    saturation = (peak - floor) / np.maximum(peak, 1)
    mask = saturation > 0.28
    if float(mask.mean()) < 0.12:
        return None
    mean = arr[mask].mean(axis=0)
    return [int(mean[0]), int(mean[1]), int(mean[2])]


def prepare_crops(image):
    width, height = image.size
    name = image.crop((int(width * 0.04), int(height * 0.50), int(width * 0.96), int(height * 0.65)))
    name = name.resize((max(1, int(name.width * 180 / name.height)), 180), Image.Resampling.LANCZOS)
    name = ImageEnhance.Contrast(name).enhance(1.4)
    stats = image.crop((int(width * 0.16), int(height * 0.63), int(width * 0.98), int(height * 0.93)))
    stats = stats.resize((stats.width * 2, stats.height * 2), Image.Resampling.LANCZOS)
    stats = ImageEnhance.Contrast(stats).enhance(1.35)
    return name, stats


def anchor_digits(card_dir):
    templates = []
    dataset = ROOT.parent / 'Draft11 dataset' / 'images' / '019_83891551.webp.png'
    dark_sources = [(card_dir / name, text) for name, text in DARK_ANCHORS.items()]
    dark_sources.append((dataset, '93'))
    for path, text in dark_sources:
        if not path.exists():
            continue
        image = Image.open(path).convert('RGB')
        width, height = image.size
        head = image.crop((0, int(height * 0.02), int(width * 0.55), int(height * 0.40)))
        glyphs = rating_glyphs(dark_text_mask(head))
        if len(glyphs) != 2:
            continue
        for index, digit in enumerate(text):
            templates.append({'label': digit, 'vec': glyphs[index][4]})
    for label, (filename, index) in ANCHORS.items():
        path = card_dir / filename
        if not path.exists():
            continue
        image = Image.open(path).convert('RGB')
        width, height = image.size
        head = image.crop((0, int(height * 0.02), int(width * 0.55), int(height * 0.40)))
        glyphs = rating_glyphs(text_mask(head))
        if index >= len(glyphs):
            continue
        templates.append({'label': label[0], 'vec': glyphs[index][4]})
    return templates


def anchor_letters(card_dir):
    """G and K sit under Ramsdale's rating. S, T, C and F come from Haaland."""
    found = []

    def take(filename, bucket, expected):
        path = card_dir / filename
        if not path.exists():
            return
        image = Image.open(path).convert('RGB')
        width, height = image.size
        head = image.crop((0, int(height * 0.02), int(width * 0.55), int(height * 0.42)))
        mask = text_mask(head)
        glyphs = rating_glyphs(mask)
        if len(glyphs) != 2:
            return
        rating_box = (glyphs[0][0], glyphs[0][1], glyphs[0][2], glyphs[1][3])
        entries = letter_rows(mask, rating_box)[bucket]
        ordered = sorted(entries, key=lambda item: item[1])
        # The two clearest letters nearest the rating, ignoring tiny noise.
        tall = [item for item in ordered if item[2].sum() > 25]
        for item, label in zip(tall, expected):
            found.append({'label': label, 'vec': item[2]})

    take('fut23_aaron_ramsdale_primary.webp', 'main', 'GK')
    take('fut23_erling_haaland_card_05.webp', 'main', 'ST')
    take('fut23_erling_haaland_card_05.webp', 'alt', 'CF')
    take('fut23_bruno_fernandes_primary.webp', 'main', 'RM')
    return found


def load_templates(card_dir):
    digits = anchor_digits(card_dir)
    letters = anchor_letters(card_dir)
    for path in sorted((TEMPLATE_DIR / 'digits').glob('*.png')):
        digits.append({'label': path.stem[0], 'vec': load_picture_template(path, (24, 20))})
    for path in sorted((TEMPLATE_DIR / 'letters').glob('*.png')):
        letters.append({'label': path.stem[0], 'vec': load_picture_template(path, (20, 16))})
    return digits, letters


def list_images(directories):
    files = []
    for directory in directories:
        root = Path(directory)
        if not root.exists():
            continue
        for path in sorted(root.iterdir()):
            if path.suffix.lower() in {'.webp', '.png'} and path.is_file():
                files.append(path)
    return files


def read_fields(head, digits, letters):
    attempts = []
    for mask in (text_mask(head), dark_text_mask(head)):
        overall, overall_distance = read_rating(mask, digits)
        position, alternates, position_distance = read_positions(mask, letters)
        attempts.append((overall, overall_distance, position, alternates, position_distance))
    rated = [item for item in attempts if item[0] is not None]
    if rated:
        return min(rated, key=lambda item: item[1] if item[1] is not None else 1)
    positioned = [item for item in attempts if item[2]]
    if len(positioned) == 1:
        return positioned[0]
    if len(positioned) == 2 and positioned[0][2] == positioned[1][2]:
        return positioned[0]
    return None, None, None, [], None


def read_image(path, digits, letters):
    raw = path.read_bytes()
    image = Image.open(path).convert('RGB')
    width, height = image.size
    head = image.crop((0, int(height * 0.02), int(width * 0.55), int(height * 0.42)))
    overall, overall_distance, position, alternates, position_distance = read_fields(head, digits, letters)
    name_crop, stats_crop = prepare_crops(image)
    return {
        'sourceImage': path.name,
        'sourcePath': str(path),
        'sourceImageHash': hashlib.sha256(raw).hexdigest(),
        'width': width,
        'height': height,
        'bytes': len(raw),
        'overall': overall,
        'overallDistance': overall_distance,
        'position': position,
        'alternatePositions': alternates,
        'positionDistance': position_distance,
        'flagSignature': flag_signature(image),
        'nationality': None,
        'club': None,
        'league': None,
        'cardType': None
    }, name_crop, stats_crop


def main():
    directories = sys.argv[1:]
    if not directories:
        raise SystemExit('Pass one or more image directories.')
    files = list_images(directories)
    card_dir = ROOT / 'frontend' / 'public' / 'player-cards'
    digits, letters = load_templates(card_dir)
    out_dir = ROOT / 'data' / 'image-catalogue' / 'crops'
    out_dir.mkdir(parents=True, exist_ok=True)
    readings = []
    for index, path in enumerate(files, start=1):
        stem = f'{index:05d}'
        try:
            record, name_crop, stats_crop = read_image(path, digits, letters)
            name_crop.save(out_dir / f'{stem}_name.png')
            stats_crop.save(out_dir / f'{stem}_stats.png')
        except Exception as error:
            raw = path.read_bytes() if path.exists() else b''
            record = {
                'sourceImage': path.name,
                'sourcePath': str(path),
                'sourceImageHash': hashlib.sha256(raw).hexdigest(),
                'width': 0,
                'height': 0,
                'bytes': len(raw),
                'overall': None,
                'overallDistance': None,
                'position': None,
                'alternatePositions': [],
                'positionDistance': None,
                'flagSignature': None,
                'nationality': None,
                'club': None,
                'league': None,
                'cardType': None,
                'readError': str(error)
            }
            print(f'skip {path.name}: {error}', file=sys.stderr)
        record['cropId'] = stem
        readings.append(record)
        if index % 200 == 0:
            print(f'read {index}/{len(files)}', file=sys.stderr)
    destination = ROOT / 'data' / 'image-catalogue' / 'image-readings.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(readings), encoding='utf-8')
    print(json.dumps({'images': len(readings), 'readings': str(destination)}))


if __name__ == '__main__':
    main()
