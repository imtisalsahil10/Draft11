/**
 * FIFA 23 MIGRATION REPORT
 * One workbook. Counts come from the plan and the import result that the
 * caller passes in.
 */

import ExcelJS from 'exceljs';

function addSheet(workbook, name, headers, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  headers.forEach((header, index) => {
    let width = String(header).length + 2;
    for (const row of rows) {
      const size = String(row[index] ?? '').length;
      if (size + 2 > width) width = Math.min(size + 2, 80);
    }
    sheet.getColumn(index + 1).width = width;
  });
  return sheet;
}

export async function writeFut23Report(file, payload) {
  const summary = payload.summary || {};
  const result = payload.result || {};
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Draft11';
  addSheet(workbook, 'Summary', ['Item', 'Value', 'Notes'], [
    ['1. Verified master player count', summary.masterPlayers ?? '', 'One row per normalized FIFA 23 name on the master workbook.'],
    ['2. Eligible new player count', summary.eligiblePlayers ?? '', 'Consistent identity, not already in the live catalogue, not held for review.'],
    ['3. Excluded identity-review count', summary.excludedReview ?? '', 'Flagged identities that were not imported.'],
    ['4. Imported player count', result.cataloguePlayers ?? result.importedPlayers ?? '', result.mode === 'dry-run'
      ? 'Dry run. Nothing was written.'
      : 'Stored in catalogue_players. The user-account players collection was not changed.'],
    ['5. Imported card-version count', result.catalogueCards ?? result.importedCards ?? '', `${summary.extraCardVersions ?? ''} are extra versions of the eligible players. The master has ${summary.masterExtraCardVersions ?? ''} extra versions in total. Versions for players already in the live catalogue, and for identity-review players, were not imported.`],
    ['6. Players with images', summary.playersWithImages ?? '', 'A local WebP exists. It is not marked legally approved.'],
    ['7. Players without images', summary.playersWithoutImages ?? '', 'No file in frontend/public/player-cards for that player id.'],
    ['8. Players with multiple card versions', summary.playersWithMultipleVersions ?? '', 'More than one FUT row for the same player id.'],
    ['9. Existing records preserved', summary.preservedLiveIds ?? '', `${summary.preservedLegacyIds ?? ''} legacy card_ records were also left in place.`],
    ['10. Duplicate or conflicting identities', result.conflicts ?? 0, 'A conflict stops the write.'],
    ['11. Failed imports', result.failed ?? 0, result.failure || 'None.'],
    ['Unassigned image files', (summary.unassignedImageFiles || []).join(', '), 'Present on disk, with no spare card version to attach. Not deleted.'],
    ['12. Test results', payload.tests?.status || 'not recorded', payload.tests?.detail || '']
  ]);
  addSheet(workbook, 'Verification', ['Measure', 'Value'], Object.entries(summary).map(([key, value]) => [key, value]));
  addSheet(workbook, 'Commands', ['Command', 'What it does'], payload.commands || []);
  addSheet(workbook, 'Eligible players', ['Player id', 'Name', 'Image status', 'Primary card'], (payload.players || []).map((player) => [
    player.playerId, player.name, player.imageStatus, player.primaryCardId
  ]));
  addSheet(workbook, 'Card versions', ['Card id', 'Player id', 'Rating', 'Position', 'Card type', 'Primary', 'Source row', 'Image'], (payload.cards || []).map((card) => [
    card.cardId,
    card.playerId,
    card.overallRating,
    card.position,
    card.cardType,
    card.isPrimary ? 'yes' : 'no',
    card.sourceRowNumber,
    card.imagePath || ''
  ]));
  addSheet(workbook, 'Identity review', ['Player id', 'Name', 'Status', 'Reason', 'Disposition'], (payload.excludedReview || []).map((player) => [
    player.playerId, player.name, player.identityStatus, player.reviewReason || '', player.disposition
  ]));
  addSheet(workbook, 'Already live', ['Player id', 'Name', 'Status', 'Live card id', 'Disposition'], (payload.alreadyLive || []).map((player) => [
    player.playerId, player.name, player.identityStatus, player.liveCardId, player.disposition
  ]));
  addSheet(workbook, 'Import result', ['Field', 'Value'], Object.entries(result).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : JSON.stringify(value)
  ]));
  await workbook.xlsx.writeFile(file);
}
