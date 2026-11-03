/**
 * LOCAL PLAYER IMAGES
 * A photo is a file named with the SoFIFA id under the local image directory.
 * Profile URLs from the CSV are not images and are never stored or fetched.
 */

import fs from 'fs';
import path from 'path';

const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

export function readApprovals(file) {
  if (!file || !fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const error = new Error(`Could not read image approvals: ${err.message}`);
    error.code = 'BAD_APPROVALS';
    throw error;
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.approved;
  if (!Array.isArray(list)) {
    const error = new Error('Image approvals must be a JSON array or { "approved": [] }.');
    error.code = 'BAD_APPROVALS';
    throw error;
  }
  const ids = [];
  for (const item of list) {
    if (typeof item === 'string' && /^fut23_[a-z0-9_]+$/.test(item)) {
      ids.push(item);
      continue;
    }
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error('Each image approval must be a positive sofifa id or a fut23 player id.');
      error.code = 'BAD_APPROVALS';
      throw error;
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Return a root-relative photo path when a real file for this id is inside
 * imageDir. Symlinks that leave the directory are ignored.
 */
export function findLocalPhoto(imageDir, sofifaId) {
  const id = String(sofifaId);
  if (!/^\d{1,12}$/.test(id) || !imageDir) return null;
  const root = path.resolve(imageDir);
  if (!fs.existsSync(root)) return null;
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }

  for (const ext of EXTENSIONS) {
    const candidate = path.resolve(root, `${id}.${ext}`);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    if (!fs.existsSync(candidate)) continue;
    let realFile;
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      realFile = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    const fromRoot = path.relative(realRoot, realFile);
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) continue;
    return `/player-images/${id}.${ext}`;
  }
  return null;
}
