"""Write small JPEG previews for the audit workbook. Source images stay put."""

import json
import sys
from pathlib import Path

from PIL import Image

destination = Path(sys.argv[1])
paths = json.loads(sys.stdin.read())
destination.mkdir(parents=True, exist_ok=True)
written = {}
for source in paths:
    path = Path(source)
    if not path.exists():
        continue
    target = destination / f'{path.stem}.jpg'
    try:
        if not target.exists() or target.stat().st_mtime < path.stat().st_mtime:
            image = Image.open(path).convert('RGB')
            image.thumbnail((96, 128), Image.Resampling.LANCZOS)
            image.save(target, 'JPEG', quality=60)
    except Exception:
        continue
    written[source] = str(target)
print(json.dumps(written))
