/**
 * Production guards. Test-only switches are ignored when NODE_ENV=production.
 */

export function isProduction(env = process.env) {
  return env.NODE_ENV === 'production';
}

export function mongoRequired(env = process.env) {
  return isProduction(env) || env.REQUIRE_MONGO === '1';
}

export function diagnosticsEnabled(env = process.env) {
  return !isProduction(env) && env.DRAFT11_DIAGNOSTICS === '1';
}

export function testRoomFile(env = process.env) {
  if (isProduction(env)) return '';
  return env.DRAFT11_ROOM_FILE || env.DRAFT11_TEST_ROOM_FILE || '';
}

export function testCardLimitEnabled(env = process.env) {
  return !isProduction(env) && env.DRAFT11_TEST_CARD_LIMIT === '1';
}

/**
 * /health is healthy only while MongoDB is connected.
 */
export function healthBody({ connected, stats = {}, now = new Date() } = {}) {
  const timestamp = now.toISOString();
  if (!connected) {
    return {
      statusCode: 503,
      body: {
        status: 'unavailable',
        database: 'disconnected',
        timestamp
      }
    };
  }
  return {
    statusCode: 200,
    body: {
      status: 'ok',
      database: 'connected',
      timestamp,
      ...stats
    }
  };
}

export function productionErrorHandler(err, _req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err?.type === 'entity.parse.failed' || err?.status === 400 ? 400 : 500;
  res.status(status).json({
    success: false,
    error: status === 400 ? 'Invalid request' : 'Internal server error'
  });
}
