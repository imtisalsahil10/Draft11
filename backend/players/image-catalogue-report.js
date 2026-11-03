/**
 * AUDIT WORKBOOK
 * One workbook for the image-derived catalogue. Image previews are local
 * JPEG thumbnails. Nothing here is written to MongoDB.
 */

import ExcelJS from 'exceljs';
import fs from 'fs';

function addSheet(workbook, name, headers, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length }
  };
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

function attributesOf(player) {
  const outfield = [
    ['Pace', player.pace],
    ['Shooting', player.shooting],
    ['Passing', player.passing],
    ['Dribbling', player.dribbling],
    ['Defending', player.defending],
    ['Physical', player.physical]
  ].filter(([, value]) => value != null).map(([label, value]) => `${label} ${value}`);
  const keeper = player.goalkeeperAttributes
    ? Object.entries(player.goalkeeperAttributes).map(([label, value]) => `${label} ${value}`)
    : [];
  return [...outfield, ...keeper].join(', ');
}

function embed(workbook, sheet, rowNumber, column, file) {
  if (!file || !fs.existsSync(file)) return;
  const imageId = workbook.addImage({
    buffer: fs.readFileSync(file),
    extension: 'jpeg'
  });
  sheet.addImage(imageId, {
    tl: { col: column, row: rowNumber },
    ext: { width: 54, height: 72 }
  });
  sheet.getRow(rowNumber + 1).height = 58;
}

export async function writeImageCatalogueReport(file, payload, thumbs = new Map()) {
  const summary = payload.summary || {};
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Draft11';
  const players = payload.players || payload.records || [];
  addSheet(workbook, 'Summary', ['Item', 'Value', 'Notes'], [
    ['Total images scanned', summary.imagesScanned ?? '', 'WebP cards in frontend/public/player-cards and PNG cards in the dataset images folder. Original files were not moved or deleted.'],
    ['Player identities retained', summary.identitiesRetained ?? summary.uniqueIdentities ?? '', 'Every identified card-name group stays in the master catalogue. A missing league does not remove the player.'],
    ['Players rated 85+', summary.passedOverall ?? '', 'The selected card has a readable overall of at least 85. This is the elite rating threshold, not a reason to delete the player.'],
    ['Players below 85', summary.belowOverall ?? '', 'The selected card has a readable overall under 85. The player stays in the master catalogue and is not auction eligible.'],
    ['Players with a readable position', summary.readablePositions ?? '', 'The main position was read from the selected card.'],
    ['Players with an unknown league', summary.unknownLeagues ?? '', 'The league name is not printed on the card. It is left unknown and is not guessed from the club or the flag.'],
    ['Players requiring identity review', summary.identityReview ?? '', 'Similar names, uncertain OCR, a missing position, missing attributes, or a printed league outside the five supported leagues.'],
    ['Eligible for a future auction import', summary.futureAuctionImport ?? '', 'Identified, overall at least 85, position read, and a verified supported league. None are activated. Image rights stay unverified.'],
    ['Players with a selected local image', summary.selectedLocalImages ?? '', 'Each retained player has one selected card file. Public paths exist only for files already under frontend/public/player-cards.'],
    ['Selected highest-rated cards', summary.selectedCards ?? '', 'One card per identity. Attributes and artwork come only from that card.'],
    ['Duplicate/alternative cards', summary.alternativeCards ?? '', 'Lower-rated or tied versions. Archived, not deleted.'],
    ['Ambiguous identities', summary.ambiguousIdentities ?? '', 'A similar card name was kept as its own identity. These names were not merged.'],
    ['Unreadable cards', summary.unreadableCards ?? '', 'Neither the name nor the overall rating could be read. These cards are rejected and are not player records.'],
    ['Printed leagues outside the supported five', summary.excludedByLeague ?? '', 'The card text named another league. The player stays in the database with league status needs_review.']
  ]);

  addSheet(workbook, 'Final Player Database', [
    'Player name', 'OCR name', 'Player ID', 'Overall rating', 'Position', 'Nationality', 'Club', 'League',
    'League status', 'Catalogue status', 'Auction eligible', 'Image rights', 'Card type',
    'Image filename', 'Extracted attributes', 'Confidence'
  ], players.map((player) => [
    player.name,
    player.ocrName ?? '',
    player.playerId,
    player.overall ?? '',
    player.position ?? '',
    player.nationality ?? '',
    player.club ?? '',
    player.league ?? '',
    player.leagueStatus ?? '',
    player.catalogueStatus ?? '',
    player.auctionEligible ? 'true' : 'false',
    player.imageRightsStatus || 'unverified',
    player.cardType ?? '',
    player.sourceImage,
    attributesOf(player),
    `extraction ${player.extractionConfidence}; identity ${player.identityConfidence}`
  ]));

  const reports = payload.reviewReports || {};
  const reportRows = (rows) => (rows || []).map((row) => [
    row.name || '',
    row.ocrName || '',
    row.playerId || '',
    row.overall ?? '',
    row.position ?? '',
    row.league ?? '',
    row.sourceImage || '',
    row.reason || ''
  ]);
  const reportHeaders = ['Player name', 'OCR name', 'Player ID', 'Overall', 'Position', 'League', 'Image filename', 'Reason'];
  addSheet(workbook, 'Uncertain OCR', reportHeaders, reportRows(reports.uncertainOcr));
  addSheet(workbook, 'Similar Names', reportHeaders, reportRows(reports.similarNames));
  addSheet(workbook, 'Missing Positions', reportHeaders, reportRows(reports.missingPositions));
  addSheet(workbook, 'Unknown Leagues', reportHeaders, reportRows(reports.unknownLeagues));
  addSheet(workbook, 'Missing Attributes', reportHeaders, reportRows(reports.missingAttributes));
  addSheet(workbook, 'Conflicting Identities', reportHeaders, reportRows(reports.conflictingIdentities));

  const selectedSheet = addSheet(workbook, 'Selected Cards', [
    'Player', 'Selected image preview', 'Selected rating', 'Reason selected'
  ], (payload.selected || []).map((card) => [
    card.name || card.identityName || '',
    '',
    card.overall ?? '',
    card.selectionReason || ''
  ]));
  (payload.selected || []).forEach((card, index) => {
    embed(workbook, selectedSheet, index + 1, 1, thumbs.get(card.sourcePath));
  });

  const alternativeSheet = addSheet(workbook, 'Alternative Cards', [
    'Player', 'Alternative image preview', 'Rating', 'Reason not selected'
  ], (payload.alternatives || []).map((card) => [
    card.name || card.identityName || '',
    '',
    card.overall ?? '',
    card.reasonNotSelected || ''
  ]));
  (payload.alternatives || []).forEach((card, index) => {
    embed(workbook, alternativeSheet, index + 1, 1, thumbs.get(card.sourcePath));
  });

  const reviewSheet = addSheet(workbook, 'Manual Review', [
    'Image preview', 'OCR output', 'Suggested identity', 'Reason for uncertainty'
  ], (payload.review || []).map((card) => [
    '',
    card.rawOcr || '',
    card.playerId || card.name || '',
    card.reason || (card.identityReasons || []).join(' ')
  ]));
  (payload.review || []).forEach((card, index) => {
    embed(workbook, reviewSheet, index + 1, 0, thumbs.get(card.sourcePath));
  });

  const excludedSheet = addSheet(workbook, 'Excluded Cards', [
    'Image preview', 'Player name', 'Rating', 'Reason for exclusion'
  ], (payload.excluded || []).map((card) => [
    '',
    card.name || '',
    card.overall ?? '',
    card.reason || ''
  ]));
  (payload.excluded || []).forEach((card, index) => {
    embed(workbook, excludedSheet, index + 1, 0, thumbs.get(card.sourcePath));
  });

  await workbook.xlsx.writeFile(file);
}
