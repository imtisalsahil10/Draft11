/**
 * LOCAL REVIEW API
 * There is no signed-in reviewer. Session ids are labels supplied by the browser.
 */

import { Router } from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { createReviewStore, defaultReviewStorePath } from './identity-review-store.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export function createIdentityReviewRouter(store = createReviewStore(defaultReviewStorePath(repoRoot))) {
  const router = Router();

  function sendError(response, error) {
    response.status(error.status || 500).json({
      error: error.message,
      current: error.current || null,
      authenticated: false
    });
  }

  router.get('/decisions', async (_request, response) => {
    response.json({ ...(await store.read()), authenticated: false });
  });

  router.put('/decisions/:playerId', async (request, response) => {
    try {
      const saved = await store.saveDecision({ ...request.body, playerId: request.params.playerId });
      response.json(saved);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/decisions/:playerId/undo', async (request, response) => {
    try {
      response.json(await store.undoDecision(request.params.playerId, request.body || {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/duplicates/:pairId', async (request, response) => {
    try {
      const saved = await store.saveDuplicate({ ...request.body, pairId: request.params.pairId });
      response.json(saved);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/duplicates/:pairId/undo', async (request, response) => {
    try {
      response.json(await store.undoDuplicate(request.params.pairId, request.body || {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/export', async (_request, response) => {
    const store = await store.read();
    response.setHeader('Content-Disposition', 'attachment; filename="identity-review-store.json"');
    response.json(store);
  });

  router.post('/backup', async (_request, response) => {
    const directory = path.join(repoRoot, 'data', 'image-catalogue', 'review-backups');
    response.json({ file: await store.backup(directory), authenticated: false });
  });

  router.post('/restore', async (request, response) => {
    try {
      response.json(await store.restore(request.body || {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

export const identityReviewRouter = createIdentityReviewRouter();
