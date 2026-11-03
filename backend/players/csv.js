/**
 * Small CSV reader for the FIFA import.
 * Quoted fields may contain commas and doubled quotes. The player file is
 * read once by the importer, not while a card is rendered.
 */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const source = String(text || '');

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((record) => record.some((value) => String(value).trim() !== ''));
}

export function rowsToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) {
    const error = new Error('The CSV has no header row.');
    error.code = 'EMPTY_CSV';
    throw error;
  }
  const headers = rows[0].map((header) => String(header || '').trim());
  const records = [];
  for (const row of rows.slice(1)) {
    const record = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[header] = row[index] == null ? '' : String(row[index]);
    });
    records.push(record);
  }
  return { headers, records };
}
