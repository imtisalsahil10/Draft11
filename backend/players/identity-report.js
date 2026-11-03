/**
 * Identity verification workbook. Image previews are local thumbnails.
 * Nothing here is written to MongoDB.
 */

import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';

function addSheet(workbook, name, headers, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  headers.forEach((header, index) => {
    let width = String(header).length + 2;
    for (const row of rows) {
      const size = String(row[index] ?? '').length;
      if (size + 2 > width) width = Math.min(size + 2, 72);
    }
    sheet.getColumn(index + 1).width = width;
  });
  return sheet;
}

function embed(workbook, sheet, rowNumber, column, file) {
  if (!file || !fs.existsSync(file)) return;
  const imageId = workbook.addImage({ buffer: fs.readFileSync(file), extension: 'jpeg' });
  sheet.addImage(imageId, {
    tl: { col: column, row: rowNumber },
    ext: { width: 54, height: 72 }
  });
  sheet.getRow(rowNumber + 1).height = 58;
}

export function thumbFor(sourceImage, thumbDir) {
  if (!sourceImage) return null;
  const file = path.join(thumbDir, sourceImage.replace(/\.[^.]+$/, '.jpg'));
  return fs.existsSync(file) ? file : null;
}

function evidenceText(record) {
  const fields = ['fullName', 'nationality', 'club', 'league', 'position']
    .map((key) => `${key}: ${record.enriched[key].status}${record.enriched[key].value ? ` (${record.enriched[key].value})` : ''}`);
  return [...record.identity.evidence, ...fields].join(' | ');
}

export async function writeIdentityWorkbook(file, result, thumbDir) {
  const { summary, records, duplicates } = result;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Draft11';
  addSheet(workbook, 'Summary', ['Item', 'Value', 'Notes'], [
    ['Total identities', summary.totalIdentities, 'Every image-derived player ID is retained. None were merged or deleted.'],
    ['Verified identities', summary.verified, 'Card name, one Wikidata footballer, and the card position agree. Original OCR text is unchanged.'],
    ['High-confidence candidates', summary.highConfidenceCandidates, 'A plausible identity exists, but it was not promoted to verified.'],
    ['Manual review', summary.manualReview, 'Incomplete names, spelling questions, or no second source.'],
    ['Ambiguous identities', summary.ambiguous, 'Conflicting evidence or more than one reference footballer. Not merged.'],
    ['Unidentified records', summary.unidentified, 'The OCR name cannot support an identity.'],
    ['Verified nationality', summary.verifiedNationality, 'One Wikidata citizenship on a verified identity. Flags were not used.'],
    ['Verified club', summary.verifiedClub, `A dated senior-club membership brackets ${summary.referenceDate}.`],
    ['Verified league', summary.verifiedLeague, 'No dated 2022-23 league membership was available, so leagues were not guessed from the current club.'],
    ['Possible duplicate pairs', summary.possibleDuplicates, 'Similar names were kept as separate records.'],
    ['Verified name proposals', summary.namesCorrected, 'Proposed canonical names that differ from the OCR name. The extracted name was not overwritten.'],
    ['Source', summary.source, 'Wikidata SPARQL, CC0. FIFA 23 reference date is the game release window, not a 2026 club.']
  ]);

  const verified = records.filter((record) => record.verificationStatus === 'verified');
  const verifiedSheet = addSheet(workbook, 'Verified Players', [
    'Player ID', 'Canonical name', 'Original OCR name', 'Selected image', 'Overall', 'Position',
    'Nationality', 'Club', 'League', 'Evidence and confidence'
  ], verified.map((record) => [
    record.playerId,
    record.identity.proposedCanonicalName || '',
    record.ocrName || record.extractedName || '',
    '',
    record.overall ?? '',
    record.position ?? '',
    record.enriched.nationality.value || '',
    record.enriched.club.value || '',
    record.enriched.league.value || '',
    `${evidenceText(record)} Confidence ${record.identity.matchConfidence}.`
  ]));
  verified.forEach((record, index) => embed(workbook, verifiedSheet, index + 1, 3, thumbFor(record.sourceImage, thumbDir)));

  addSheet(workbook, 'Possible Duplicates', [
    'Player ID', 'Extracted name', 'Other player ID', 'Other extracted name', 'Suggested match', 'Supporting evidence', 'Review decision'
  ], duplicates.map((pair) => [
    pair.playerId,
    pair.extractedName,
    pair.otherPlayerId,
    pair.otherExtractedName,
    pair.suggestedMatch || '',
    pair.supportingEvidence,
    pair.reviewDecision
  ]));

  const review = records.filter((record) => record.verificationStatus !== 'verified');
  const reviewSheet = addSheet(workbook, 'Manual Review', [
    'Image preview', 'Original name', 'Suggested identity', 'Reason for uncertainty'
  ], review.map((record) => [
    '',
    record.ocrName || record.extractedName || '',
    record.identity.proposedCanonicalName || '',
    `${record.verificationStatus}. ${record.identity.reason}`
  ]));
  review.forEach((record, index) => embed(workbook, reviewSheet, index + 1, 0, thumbFor(record.sourceImage, thumbDir)));

  addSheet(workbook, 'Missing Information', [
    'Player ID', 'Name', 'Missing fields', 'Available evidence'
  ], records.filter((record) => ['fullName', 'nationality', 'club', 'league', 'position'].some((key) => record.enriched[key].status !== 'verified'))
    .map((record) => {
      const missing = ['fullName', 'nationality', 'club', 'league', 'position']
        .filter((key) => record.enriched[key].status !== 'verified');
      return [
        record.playerId,
        record.extractedName || '',
        missing.join(', '),
        record.identity.evidence.join(' ') || record.identity.reason
      ];
    }));

  await workbook.xlsx.writeFile(file);
}
