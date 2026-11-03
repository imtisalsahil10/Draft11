/**
 * Process restart against MongoDB.
 * This is skipped when MONGODB_URI is missing or the server cannot be
 * reached. A new service.load() in other tests is not this test.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { insertHandoffs, takeElevens } from './support/handoff-seed.js';
import { createIsolatedRoomFile } from './support/isolated-rooms.js';

dotenv.config();

const dbName = `draft11_league_restart_${Date.now()}`;
const port = 3097;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mongoAvailable() {
  if (!process.env.MONGODB_URI) return false;
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName,
      serverSelectionTimeoutMS: 2500,
      connectTimeoutMS: 2500
    });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    return true;
  } catch {
    await mongoose.disconnect().catch(() => {});
    return false;
  }
}

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(500);
  }
  throw new Error('Server did not become healthy');
}

function startServer() {
  const rooms = createIsolatedRoomFile();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      MONGODB_DB_NAME: dbName,
      REQUIRE_MONGO: '1',
      SOCKET_IO_CORS_ORIGIN: '*',
      AUCTION_CARD_LIMIT: '1',
      DRAFT11_TEST_ROOM_FILE: rooms.file
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout?.resume();
  child.stderr?.resume();
  child.draft11RoomCleanup = rooms.cleanup;
  return child;
}

async function stopServer(child) {
  try {
    if (child && child.exitCode == null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(5000).then(() => {
          child.kill('SIGKILL');
        })
      ]);
    }
  } finally {
    child?.draft11RoomCleanup?.();
    if (child) child.draft11RoomCleanup = null;
  }
}

function ask(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 15000);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

const available = await mongoAvailable();

describe('league process restart', { skip: available ? false : 'MongoDB is not available' }, () => {
  it('keeps membership, the saved score, and standings after the backend process is killed', async () => {
    let io;
    try {
      ({ io } = await import('socket.io-client'));
    } catch {
      ({ io } = await import('../../frontend/node_modules/socket.io-client/build/esm/index.js'));
    }

    let child = startServer();
    try {
      await waitForHealth(child);
      const home = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      const away = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      await Promise.all([
        new Promise((resolve) => home.on('connect', resolve)),
        new Promise((resolve) => away.on('connect', resolve))
      ]);

      const created = await ask(home, 'league:create', { name: 'Restart Cup', displayName: 'Ada' });
      assert.equal(created.success, true, created.message);
      const joined = await ask(away, 'league:join', {
        inviteCode: created.inviteCode,
        displayName: 'Bea'
      });
      assert.equal(joined.success, true, joined.message);
      const ada = {
        leagueId: created.league.leagueId,
        memberId: created.memberId,
        memberToken: created.memberToken
      };
      const bea = {
        leagueId: joined.league.leagueId,
        memberId: joined.memberId,
        memberToken: joined.memberToken
      };
      const groups = takeElevens(2);
      const seed = await mongoose.createConnection(process.env.MONGODB_URI, {
        dbName,
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000
      }).asPromise();
      try {
        await insertHandoffs(seed, groups);
      } finally {
        await seed.close().catch(() => {});
      }
      assert.equal((await ask(home, 'league:squad:link-auction', { ...ada, seatToken: groups[0].token })).success, true);
      assert.equal((await ask(away, 'league:squad:link-auction', { ...bea, seatToken: groups[1].token })).success, true);
      assert.equal((await ask(home, 'league:schedule', ada)).success, true);
      const fixtureId = created.league.leagueId
        ? (await ask(home, 'league:state', ada)).league.fixtures[0].fixtureId
        : null;
      assert.equal((await ask(home, 'league:fixture:confirm-lineup', {
        ...ada,
        fixtureId,
        formation: groups[0].formation,
        assignments: groups[0].assignments,
        expectedRevision: 0
      })).success, true);
      assert.equal((await ask(away, 'league:fixture:confirm-lineup', {
        ...bea,
        fixtureId,
        formation: groups[1].formation,
        assignments: groups[1].assignments,
        expectedRevision: 0
      })).success, true);
      const played = await ask(home, 'league:fixture:simulate', { ...ada, fixtureId });
      assert.equal(played.success, true, played.message);
      const score = played.result;

      home.close();
      away.close();
      await stopServer(child);
      child = startServer();
      await waitForHealth(child);

      const returning = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      await new Promise((resolve) => returning.on('connect', resolve));
      const state = await ask(returning, 'league:state', ada);
      assert.equal(state.success, true, state.message);
      assert.equal(state.league.fixtures[0].result.homeGoals, score.homeGoals);
      assert.equal(state.league.fixtures[0].result.awayGoals, score.awayGoals);
      assert.deepEqual(
        state.league.standings.map((row) => ({ memberId: row.memberId, points: row.points })),
        played.league.standings.map((row) => ({ memberId: row.memberId, points: row.points }))
      );
      const retry = await ask(returning, 'league:fixture:simulate', { ...bea, fixtureId });
      assert.equal(retry.success, true, retry.message);
      assert.equal(retry.alreadyComplete, true);
      assert.equal(retry.result.homeGoals, score.homeGoals);
      assert.equal(retry.result.awayGoals, score.awayGoals);
      assert.equal(retry.league.standings.reduce((sum, row) => sum + row.points, 0), played.league.standings.reduce((sum, row) => sum + row.points, 0));
      returning.close();
    } finally {
      await stopServer(child);
      try {
        await mongoose.connect(process.env.MONGODB_URI, {
          dbName,
          serverSelectionTimeoutMS: 2500
        });
        await mongoose.connection.dropDatabase();
      } catch {
        // The database may already be gone.
      }
      await mongoose.disconnect().catch(() => {});
    }
  });
});
