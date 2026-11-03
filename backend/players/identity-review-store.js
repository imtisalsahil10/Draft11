/**
 * FILE STORE FOR IDENTITY REVIEW
 * Decisions live beside the image catalogue. They do not touch MongoDB,
 * auction cards, squads, or the original OCR record.
 */

import fs from 'fs';
import path from 'path';
import { DUPLICATE_DECISIONS, REVIEW_DECISIONS, duplicatePairId } from '../../shared/identity-review.js';

const EMPTY = () => ({
  version: 1,
  authenticated: false,
  decisions: {},
  duplicateDecisions: {},
  audit: []
});

export function createReviewStore(filePath) {
  let chain = Promise.resolve();

  function exclusive(work) {
    const run = chain.then(work, work);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function read() {
    if (!fs.existsSync(filePath)) return EMPTY();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      version: 1,
      authenticated: false,
      decisions: parsed.decisions || {},
      duplicateDecisions: parsed.duplicateDecisions || {},
      audit: parsed.audit || []
    };
  }

  function write(store) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
    fs.renameSync(temporary, filePath);
  }

  function snapshotOf(entry) {
    return {
      decision: entry.decision,
      correctedName: entry.correctedName || null,
      mergePlan: entry.mergePlan || null,
      updatedAt: entry.updatedAt,
      revision: entry.revision,
      sessionId: entry.sessionId,
      authenticated: false
    };
  }

  function refuseStale(current, expectedRevision) {
    const revision = current?.revision || 0;
    if (expectedRevision !== revision) {
      const error = new Error('A newer review decision is already saved.');
      error.status = 409;
      error.current = current || null;
      throw error;
    }
  }

  function sessionOf(sessionId) {
    const value = String(sessionId || '').trim();
    return value || 'unauthenticated';
  }

  return {
    filePath,
    read: () => exclusive(async () => read()),

    saveDecision(input) {
      return exclusive(async () => {
        const decision = input?.decision;
        if (!REVIEW_DECISIONS.includes(decision)) {
          const error = new Error('The decision must be confirm, correct, reject, or unresolved.');
          error.status = 400;
          throw error;
        }
        const correctedName = decision === 'correct' ? String(input.correctedName || '').trim() : null;
        if (decision === 'correct' && !correctedName) {
          const error = new Error('A corrected name is required.');
          error.status = 400;
          throw error;
        }
        const store = read();
        const playerId = String(input.playerId || '');
        const current = store.decisions[playerId] || null;
        refuseStale(current, Number(input.expectedRevision || 0));
        const next = {
          playerId,
          ocrName: input.ocrName ?? null,
          proposedCanonicalName: input.proposedCanonicalName ?? null,
          decision,
          correctedName,
          updatedAt: new Date().toISOString(),
          revision: (current?.revision || 0) + 1,
          sessionId: sessionOf(input.sessionId),
          authenticated: false,
          history: current ? [...(current.history || []), snapshotOf(current)] : []
        };
        store.decisions[playerId] = next;
        store.audit.push({
          type: 'decision',
          playerId,
          at: next.updatedAt,
          revision: next.revision,
          sessionId: next.sessionId,
          authenticated: false,
          previous: current ? snapshotOf(current) : null,
          decision
        });
        write(store);
        return next;
      });
    },

    undoDecision(playerId, input = {}) {
      return exclusive(async () => {
        const store = read();
        const current = store.decisions[playerId];
        if (!current) {
          const error = new Error('There is no decision to undo.');
          error.status = 404;
          throw error;
        }
        refuseStale(current, Number(input.expectedRevision || 0));
        const history = [...(current.history || [])];
        const previous = history.pop();
        if (!previous) {
          const error = new Error('There is no earlier decision to restore.');
          error.status = 409;
          throw error;
        }
        const restored = {
          ...current,
          decision: previous.decision,
          correctedName: previous.correctedName,
          updatedAt: new Date().toISOString(),
          revision: current.revision + 1,
          sessionId: sessionOf(input.sessionId),
          authenticated: false,
          history
        };
        store.decisions[playerId] = restored;
        store.audit.push({
          type: 'undo',
          playerId,
          at: restored.updatedAt,
          revision: restored.revision,
          sessionId: restored.sessionId,
          authenticated: false,
          previous: snapshotOf(current),
          restored: snapshotOf(restored)
        });
        write(store);
        return restored;
      });
    },

    saveDuplicate(input) {
      return exclusive(async () => {
        const decision = input?.decision;
        if (!DUPLICATE_DECISIONS.includes(decision)) {
          const error = new Error('The duplicate decision must be same, different, or unresolved.');
          error.status = 400;
          throw error;
        }
        const pairId = duplicatePairId(input.playerId, input.otherPlayerId);
        const store = read();
        const current = store.duplicateDecisions[pairId] || null;
        refuseStale(current, Number(input.expectedRevision || 0));
        const updatedAt = new Date().toISOString();
        const mergePlan = decision === 'same'
          ? {
            playerId: input.playerId,
            otherPlayerId: input.otherPlayerId,
            status: 'planned',
            executed: false,
            reversible: true,
            createdAt: updatedAt
          }
          : null;
        const next = {
          pairId,
          playerId: input.playerId,
          otherPlayerId: input.otherPlayerId,
          decision,
          mergePlan,
          updatedAt,
          revision: (current?.revision || 0) + 1,
          sessionId: sessionOf(input.sessionId),
          authenticated: false,
          history: current ? [...(current.history || []), snapshotOf(current)] : []
        };
        store.duplicateDecisions[pairId] = next;
        store.audit.push({
          type: 'duplicate',
          pairId,
          at: updatedAt,
          revision: next.revision,
          sessionId: next.sessionId,
          authenticated: false,
          previous: current ? snapshotOf(current) : null,
          decision,
          mergeExecuted: false
        });
        write(store);
        return next;
      });
    },

    undoDuplicate(pairId, input = {}) {
      return exclusive(async () => {
        const store = read();
        const current = store.duplicateDecisions[pairId];
        if (!current) {
          const error = new Error('There is no duplicate decision to undo.');
          error.status = 404;
          throw error;
        }
        refuseStale(current, Number(input.expectedRevision || 0));
        const history = [...(current.history || [])];
        const previous = history.pop();
        if (!previous) {
          const error = new Error('There is no earlier duplicate decision to restore.');
          error.status = 409;
          throw error;
        }
        const restored = {
          ...current,
          decision: previous.decision,
          mergePlan: previous.decision === 'same' && previous.mergePlan?.executed === false ? previous.mergePlan : null,
          updatedAt: new Date().toISOString(),
          revision: current.revision + 1,
          sessionId: sessionOf(input.sessionId),
          authenticated: false,
          history
        };
        store.duplicateDecisions[pairId] = restored;
        store.audit.push({
          type: 'undo-duplicate',
          pairId,
          at: restored.updatedAt,
          revision: restored.revision,
          sessionId: restored.sessionId,
          authenticated: false,
          previous: snapshotOf(current)
        });
        write(store);
        return restored;
      });
    },

    backup(directory) {
      return exclusive(async () => {
        const store = read();
        fs.mkdirSync(directory, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(directory, `identity-review-store-${stamp}.json`);
        fs.writeFileSync(dest, JSON.stringify(store, null, 2));
        return dest;
      });
    },

    restore(snapshot) {
      return exclusive(async () => {
        const store = read();
        const incoming = snapshot?.decisions || {};
        const incomingPairs = snapshot?.duplicateDecisions || {};
        let kept = 0;
        let ignored = 0;
        for (const [playerId, entry] of Object.entries(incoming)) {
          const current = store.decisions[playerId];
          if (!current || (entry.revision || 0) > current.revision) {
            store.decisions[playerId] = entry;
            kept += 1;
          } else ignored += 1;
        }
        for (const [pairId, entry] of Object.entries(incomingPairs)) {
          const current = store.duplicateDecisions[pairId];
          if (!current || (entry.revision || 0) > current.revision) {
            store.duplicateDecisions[pairId] = entry;
            kept += 1;
          } else ignored += 1;
        }
        store.audit.push({
          type: 'restore',
          at: new Date().toISOString(),
          authenticated: false,
          kept,
          ignoredNewer: ignored
        });
        if (Array.isArray(snapshot?.audit)) {
          const seen = new Set(store.audit.map((item) => JSON.stringify(item)));
          for (const item of snapshot.audit) {
            const key = JSON.stringify(item);
            if (!seen.has(key)) store.audit.push(item);
          }
        }
        write(store);
        return { kept, ignoredNewer: ignored };
      });
    }
  };
}

export function defaultReviewStorePath(repoRoot) {
  return path.join(repoRoot, 'data', 'image-catalogue', 'identity-review-store.json');
}
