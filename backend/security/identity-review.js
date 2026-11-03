/**
 * The review API is a local catalogue tool. Production does not mount it.
 */

import { isProduction } from './production.js';
import { identityReviewRouter } from '../players/identity-review-routes.js';

export function mountIdentityReview(app, env = process.env) {
  if (isProduction(env)) {
    app.use('/api/identity-review', (_req, res) => {
      res.status(404).json({ success: false, error: 'Not found' });
    });
    return;
  }
  app.use('/api/identity-review', identityReviewRouter);
}
