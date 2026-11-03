import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, it } from 'node:test';
import { Server } from 'socket.io';
import { AuctionEngine } from '../auction-engine.js';
import { RoomManager } from '../room-manager.js';
import { captureLiveRoom, indexCards, materializeLiveRoom } from '../room-snapshot.js';
import { createOriginGuard, originAllowed, socketCors } from '../security/origins.js';
import { mountIdentityReview } from '../security/identity-review.js';
import { migrateRoomDocument, verifySeatTokenBackup } from '../security/migrate-seat-tokens.js';
import {
  diagnosticsEnabled,
  healthBody,
  mongoRequired,
  productionErrorHandler,
  testCardLimitEnabled
} from '../security/production.js';
import { createRateLimiter, httpLimit } from '../security/rate-limit.js';
import { hashSeatToken } from '../security/seat-token.js';
import { generateRoomCode, redactSecrets } from '../utils.js';
import { loadIo } from './support/live-server.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('production origin allowlist', () => {
  it('allows a configured origin and rejects every other browser origin in production', () => {
    const env = { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://draft.example, *' };
    assert.equal(originAllowed('https://draft.example', env), true);
    assert.equal(originAllowed('https://evil.example', env), false);
    assert.equal(originAllowed('http://localhost:5173', env), false);
    assert.equal(originAllowed('*', env), false);
    assert.equal(originAllowed(undefined, env), true);
  });

  it('allows local development origins only outside production', () => {
    const env = { NODE_ENV: 'test', ALLOWED_ORIGINS: '' };
    assert.equal(originAllowed('http://localhost:5199', env), true);
    assert.equal(originAllowed('http://127.0.0.1:5173', env), true);
    assert.equal(originAllowed('https://evil.example', env), false);
    assert.equal(originAllowed('*', env), false);
  });

  it('answers allowed and rejected HTTP origins', async () => {
    const app = express();
    app.use(createOriginGuard({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://draft.example' }));
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    const server = createServer(app);
    const port = await listen(server);
    try {
      const allowed = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: 'https://draft.example' }
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://draft.example');

      const rejected = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: 'https://evil.example' }
      });
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers.get('access-control-allow-origin'), null);

      const sameProcess = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(sameProcess.status, 200);
    } finally {
      await close(server);
    }
  });

  it('accepts an allowed Socket.IO origin and rejects the others', async () => {
    const httpServer = createServer();
    const io = new Server(httpServer, {
      cors: socketCors({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://draft.example' })
    });
    io.on('connection', (socket) => socket.emit('ready'));
    const port = await listen(httpServer);
    const clientIo = await loadIo();
    const url = `http://127.0.0.1:${port}`;
    const sockets = [];
    try {
      async function connect(origin) {
        const socket = clientIo(url, {
          transports: ['polling'],
          forceNew: true,
          reconnection: false,
          timeout: 4000,
          extraHeaders: { Origin: origin }
        });
        sockets.push(socket);
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 4000);
          socket.once('connect', () => {
            clearTimeout(timer);
            resolve('connected');
          });
          socket.once('connect_error', () => {
            clearTimeout(timer);
            resolve('rejected');
          });
        });
      }

      assert.equal(await connect('https://draft.example'), 'connected');
      assert.equal(await connect('https://evil.example'), 'rejected');
      assert.equal(await connect('http://localhost:5173'), 'rejected');
    } finally {
      for (const socket of sockets) socket.disconnect();
      io.close();
      await close(httpServer);
    }
  });
});

describe('identity review stays off in production', () => {
  async function boot(env) {
    const app = express();
    app.use(express.json());
    mountIdentityReview(app, env);
    const server = createServer(app);
    const port = await listen(server);
    return { server, port };
  }

  it('returns 404 for review reads and writes', async () => {
    const { server, port } = await boot({ NODE_ENV: 'production' });
    try {
      const paths = [
        ['GET', '/api/identity-review/decisions'],
        ['GET', '/api/identity-review/export'],
        ['PUT', '/api/identity-review/decisions/fut23_example'],
        ['POST', '/api/identity-review/backup'],
        ['POST', '/api/identity-review/restore']
      ];
      for (const [method, path] of paths) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'GET' ? undefined : '{}'
        });
        assert.equal(response.status, 404, path);
      }
    } finally {
      await close(server);
    }
  });

  it('keeps the review API available outside production', async () => {
    const { server, port } = await boot({ NODE_ENV: 'test' });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/identity-review/decisions`);
      assert.notEqual(response.status, 404);
      assert.notEqual(response.status, 403);
    } finally {
      await close(server);
    }
  });
});

describe('public write limits and room codes', () => {
  it('stops a caller after the configured number of writes', async () => {
    const app = express();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    app.post('/api/room/create', httpLimit(limiter, 'Too many rooms created. Wait a moment and try again.'), (_req, res) => {
      res.json({ success: true });
    });
    const server = createServer(app);
    const port = await listen(server);
    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/room/create`, { method: 'POST' });
      const second = await fetch(`http://127.0.0.1:${port}/api/room/create`, { method: 'POST' });
      const third = await fetch(`http://127.0.0.1:${port}/api/room/create`, { method: 'POST' });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(third.status, 429);
      const body = await third.json();
      assert.equal(body.error, 'RATE_LIMITED');
    } finally {
      await close(server);
    }
  });

  it('draws room codes from a cryptographic generator', () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error('Math.random was used');
    };
    try {
      const codes = new Set();
      for (let index = 0; index < 20; index += 1) {
        const code = generateRoomCode();
        assert.match(code, /^[A-Z0-9]{6}$/);
        codes.add(code);
      }
      assert.ok(codes.size > 1);
    } finally {
      Math.random = original;
    }
  });
});

describe('MongoDB readiness and health', () => {
  it('requires MongoDB in production and refuses a healthy report without it', () => {
    assert.equal(mongoRequired({ NODE_ENV: 'production' }), true);
    assert.equal(mongoRequired({ NODE_ENV: 'test', REQUIRE_MONGO: '0' }), false);
    assert.equal(mongoRequired({ NODE_ENV: 'test', REQUIRE_MONGO: '1' }), true);
    const down = healthBody({ connected: false, stats: { totalRooms: 2 }, now: new Date('2026-11-03T00:00:00.000Z') });
    assert.equal(down.statusCode, 503);
    assert.equal(down.body.status, 'unavailable');
    assert.equal(down.body.totalRooms, undefined);
    const up = healthBody({ connected: true, stats: { totalRooms: 2 }, now: new Date('2026-11-03T00:00:00.000Z') });
    assert.equal(up.statusCode, 200);
    assert.equal(up.body.status, 'ok');
    assert.equal(up.body.totalRooms, 2);
  });

  it('hides internal error details', () => {
    const sent = [];
    const res = {
      headersSent: false,
      status(code) {
        sent.push(code);
        return this;
      },
      json(body) {
        sent.push(body);
      }
    };
    const error = new Error('mongodb+srv://user:secret@cluster/db');
    error.stack = 'Error: secret stack';
    productionErrorHandler(error, {}, res, () => {});
    assert.deepEqual(sent[1], { success: false, error: 'Internal server error' });
    assert.equal(JSON.stringify(sent).includes('secret'), false);
    assert.equal(JSON.stringify(sent).includes('stack'), false);
    assert.equal(redactSecrets(error.message).includes('secret'), false);
  });

  it('exits production startup when MongoDB is not configured', async () => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        REQUIRE_MONGO: '1',
        MONGODB_URI: '',
        PORT: '3219',
        ALLOWED_ORIGINS: 'https://draft.example'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve('timeout');
      }, 20000);
      child.once('exit', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 1, output);
    assert.equal(output.includes('mongodb+srv://'), false);
    assert.equal(output.includes('mongodb://'), false);
    assert.equal(output.includes('Using cards.json'), false);
  });

  it('keeps diagnostics and the short test deck disabled in production', () => {
    const env = { NODE_ENV: 'production', DRAFT11_DIAGNOSTICS: '1', DRAFT11_TEST_CARD_LIMIT: '1' };
    assert.equal(diagnosticsEnabled(env), false);
    assert.equal(testCardLimitEnabled(env), false);
    assert.equal(testCardLimitEnabled({ NODE_ENV: 'test', DRAFT11_TEST_CARD_LIMIT: '1' }), true);
  });
});

describe('seat token hashing and migration', () => {
  function card(id) {
    return { id, name: id, basePrice: 10, position: 'ST', category: 'BASIC' };
  }

  it('stores only a hash for a new seat and reconnects with the issued token', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    const ada = rooms.takeSeat(code, 'sock-1', 'ada');
    ada.player.balance = 640;
    rooms.addCardToTeam(code, 'sock-1', card('owned'));
    assert.equal(ada.player.seatToken, undefined);
    assert.equal(ada.player.seatTokenHash, hashSeatToken(ada.seatToken));
    assert.equal(rooms.takeSeat(code, 'sock-2', 'ada').error, 'seat-taken');
    const moved = rooms.takeSeat(code, 'sock-2', 'ada', ada.seatToken);
    assert.equal(moved.replaced, true);
    assert.equal(moved.seatToken, ada.seatToken);
    assert.equal(moved.player.balance, 640);
    assert.equal(moved.player.team[0].id, 'owned');
    assert.equal(rooms.getRoom(code).hostUsername, 'ada');
  });

  it('still accepts a legacy raw token and keeps the seat after hashing it', () => {
    const rooms = new RoomManager();
    const engine = new AuctionEngine();
    const code = rooms.createRoom();
    const ada = rooms.takeSeat(code, 'sock-1', 'ada');
    rooms.takeSeat(code, 'sock-bea', 'bea');
    ada.player.balance = 640;
    rooms.addCardToTeam(code, 'sock-1', card('owned'));
    const raw = ada.seatToken;
    const captured = captureLiveRoom(rooms.getRoom(code), engine.getAuction(code));
    captured.state.seats[0].seatToken = raw;
    delete captured.state.seats[0].seatTokenHash;
    const hostSeatId = captured.hostSeatId;
    const balance = captured.state.seats[0].balance;
    const cardIds = captured.state.seats[0].cardIds.slice();

    const legacy = materializeLiveRoom(captured, { catalog: indexCards([card('owned')]) });
    const restored = new RoomManager();
    restored.restoreRoom(legacy.room);
    assert.equal(restored.takeSeat(code, 'other', 'ada', 'wrong-token-value-that-is-long-enough').error, 'seat-taken');
    const back = restored.takeSeat(code, 'other', 'ada', raw);
    assert.equal(back.replaced, true);
    assert.equal(back.seatToken, raw);
    assert.equal(back.player.balance, 640);
    assert.equal(back.player.team[0].id, 'owned');
    assert.equal(restored.getRoom(code).hostSeatId, hostSeatId);

    const backup = JSON.parse(JSON.stringify([captured]));
    assert.equal(verifySeatTokenBackup([captured], backup), true);
    const migrated = migrateRoomDocument(captured);
    assert.equal(migrated.changed, true);
    assert.equal(migrated.doc.state.seats[0].seatToken, undefined);
    assert.equal(migrated.doc.state.seats[0].seatTokenHash, hashSeatToken(raw));
    assert.equal(migrated.doc.state.seats[0].balance, balance);
    assert.deepEqual(migrated.doc.state.seats[0].cardIds, cardIds);
    assert.equal(migrated.doc.hostSeatId, hostSeatId);
    assert.equal(JSON.stringify(migrated.doc).includes(raw), false);
    assert.equal(verifySeatTokenBackup([captured], [migrated.doc]), false);

    const again = migrateRoomDocument(migrated.doc);
    assert.equal(again.changed, false);
    assert.equal(again.doc.state.seats[0].seatTokenHash, hashSeatToken(raw));

    const hashed = materializeLiveRoom(migrated.doc, { catalog: indexCards([card('owned')]) });
    const after = new RoomManager();
    after.restoreRoom(hashed.room);
    const recovered = after.takeSeat(code, 'final', 'ada', raw);
    assert.equal(recovered.replaced, true);
    assert.equal(recovered.seatToken, raw);
    assert.equal(recovered.player.balance, balance);
    assert.equal(recovered.player.seatToken, undefined);
    assert.equal(after.getRoom(code).hostSeatId, hostSeatId);
    assert.equal(after.findSeatByToken(raw).roomCode, code);
  });
});
