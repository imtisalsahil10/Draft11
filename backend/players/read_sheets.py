"""Read selected workbook sheets as JSON. Values only. No files are changed."""

import json
import sys

from openpyxl import load_workbook


def sheet_rows(workbook, name):
    if name not in workbook.sheetnames:
        raise SystemExit(f'Missing sheet: {name}')
    worksheet = workbook[name]
    rows = worksheet.iter_rows(values_only=True)
    header = [str(cell).strip() if cell is not None else '' for cell in next(rows)]
    data = []
    for raw in rows:
        item = {}
        any_value = False
        for index, key in enumerate(header):
            if not key:
                continue
            value = raw[index] if index < len(raw) else None
            if value is not None and str(value).strip() != '':
                any_value = True
            item[key] = value
        if any_value:
            data.append(item)
    return data


def main():
    path, *names = sys.argv[1:]
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        payload = {name: sheet_rows(workbook, name) for name in names}
    finally:
        workbook.close()
    json.dump(payload, sys.stdout, ensure_ascii=True, default=str)


if __name__ == '__main__':
    main()
