/**
 * Kills the backend OS process at each durable fixture step, then starts a
 * new process against the same MongoDB database. This is not a service
 * reload inside the test process.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { LEAGUE_CRASH_POINTS } from '../league-service.js';
import { resultFromSimulation } from '../league-match.js';
import { insertHandoffs, takeElevens } from './support/handoff-seed.js';
import { simulateMatch } from '../match-simulator.js';
import { SeededRandom } from '../utils.js';
import { createIsolatedRoomFile } from './support/isolated-rooms.js';

dotenv.config();

const backendRoot = fileURLToPath(new URL('..', import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openDb(dbName) {
  return mongoose.createConnection(process.env.MONGODB_URI, {
    dbName,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000
  }).asPromise();
}

let lastMongoError = '';

async function mongoAvailable(dbName) {
  if (!process.env.MONGODB_URI) {
    lastMongoError = 'MONGODB_URI missing';
    return false;
  }
  let connection;
  try {
    connection = await openDb(dbName);
    await connection.dropDatabase();
    return true;
  } catch (err) {
    lastMongoError = `${err.name}: ${String(err.message).replace(/\/\/[^/\s]+@/g, '//')}`;
    return false;
  } finally {
    await connection?.close().catch(() => {});
  }
}

function startServer(dbName, port, crashAt) {
  const logs = [];
  const rooms = createIsolatedRoomFile();
  const env = {
    ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      MONGODB_DB_NAME: dbName,
    REQUIRE_MONGO: '1',
    SOCKET_IO_CORS_ORIGIN: '*',
    DRAFT11_TEST_ROOM_FILE: rooms.file
  };
  if (crashAt) env.LEAGUE_CRASH_AFTER = crashAt;
  else delete env.LEAGUE_CRASH_AFTER;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const keep = (chunk) => {
    logs.push(chunk.toString());
    if (logs.length > 30) logs.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.logs = logs;
  child.draft11RoomCleanup = rooms.cleanup;
  return child;
}

async function waitForHealth(child, port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`Server exited with ${child.exitCode}\n${child.logs.join('')}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(500);
  }
  throw new Error(`Server did not become healthy\n${child.logs.join('')}`);
}

async function stopServer(child) {
  try {
    if (child && child.exitCode == null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(5000).then(() => child.kill('SIGKILL'))
      ]);
    }
  } finally {
    child?.draft11RoomCleanup?.();
    if (child) child.draft11RoomCleanup = null;
  }
}

function ask(socket, event, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${event}`)), 20000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('disconnect', onDisconnect);
      if (error) reject(error);
      else resolve(value);
    };
    const onDisconnect = () => finish(new Error(`socket disconnected during ${event}`));
    socket.on('disconnect', onDisconnect);
    socket.emit(event, payload, (response) => finish(null, response));
  });
}

async function readSaved(dbName, leagueId) {
  const connection = await openDb(dbName);
  try {
    const league = await connection.collection('leagues').findOne({ leagueId });
    const fixtures = await connection.collection('fixtures').find({ leagueId }).toArray();
    return { league, fixtures };
  } finally {
    await connection.close().catch(() => {});
  }
}

function replay(fixture) {
  const random = new SeededRandom(fixture.simulationSeed >>> 0);
  const simulated = simulateMatch(fixture.claimedHome, fixture.claimedAway, () => random.next());
  return resultFromSimulation(simulated, fixture.claimedHome, fixture.claimedAway);
}

function pointsOf(league) {
  return league.standings.reduce((sum, row) => sum + row.points, 0);
}

const probeDb = `cp${process.pid}`;
const available = await mongoAvailable(probeDb);

describe('league process crash recovery', {
  skip: available ? false : 'MongoDB is not available',
  concurrency: 1
}, () => {
  for (const [index, point] of LEAGUE_CRASH_POINTS.entries()) {
    it(`kills the backend process at ${point} and recovers one score`, async () => {
      let io;
      try {
        ({ io } = await import('socket.io-client'));
      } catch {
        ({ io } = await import('../../frontend/node_modules/socket.io-client/build/esm/index.js'));
      }

      const managers = point === 'before-round-reconcile' ? 3 : 2;
      const dbName = `c${index}${Date.now().toString().slice(-8)}`;
      const port = 3120 + index;
      assert.equal(await mongoAvailable(dbName), true, lastMongoError);
      let child = startServer(dbName, port, point);
      const crashedPid = child.pid;
      let home;
      let leagueId;
      let fixtureId;
      let memberAuth;
      try {
        await waitForHealth(child, port);
        const sockets = [];
        for (let seat = 0; seat < managers; seat += 1) {
          const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
          sockets.push(socket);
        }
        home = sockets[0];
        await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.on('connect', resolve))));
        const created = await ask(home, 'league:create', { name: `Crash ${point}`, displayName: 'Ada' });
        assert.equal(created.success, true, created.message);
        leagueId = created.league.leagueId;
        const auths = [{
          leagueId,
          memberId: created.memberId,
          memberToken: created.memberToken
        }];
        for (let seat = 1; seat < managers; seat += 1) {
          const joined = await ask(sockets[seat], 'league:join', {
            inviteCode: created.inviteCode,
            displayName: ['Bea', 'Cal'][seat - 1]
          });
          assert.equal(joined.success, true, joined.message);
          auths.push({
            leagueId,
            memberId: joined.memberId,
            memberToken: joined.memberToken
          });
        }
        const groups = takeElevens(managers);
        const seed = await openDb(dbName);
        try {
          await insertHandoffs(seed, groups);
        } finally {
          await seed.close().catch(() => {});
        }
        for (const [seat, auth] of auths.entries()) {
          const linked = await ask(sockets[seat], 'league:squad:link-auction', {
            ...auth,
            seatToken: groups[seat].token
          });
          assert.equal(linked.success, true, linked.message);
        }
        assert.equal((await ask(home, 'league:schedule', auths[0])).success, true);
        const scheduled = await ask(home, 'league:state', auths[0]);
        const fixture = scheduled.league.fixtures.find((item) => item.round === 1);
        fixtureId = fixture.fixtureId;
        const playing = auths.filter((auth) => (
          auth.memberId === fixture.homeMemberId || auth.memberId === fixture.awayMemberId
        ));
        assert.equal(playing.length, 2);
        for (const auth of playing) {
          const seat = auths.indexOf(auth);
          const confirmed = await ask(sockets[seat], 'league:fixture:confirm-lineup', {
            ...auth,
            fixtureId,
            formation: groups[seat].formation,
            assignments: groups[seat].assignments,
            expectedRevision: 0
          });
          assert.equal(confirmed.success, true, confirmed.message);
        }
        memberAuth = playing[0];
        const fixtureCount = scheduled.league.fixtures.length;

        const exitPromise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Process stayed up at ${point}\n${child.logs.join('')}`)), 20000);
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        });
        const attempt = ask(home, 'league:fixture:simulate', { ...memberAuth, fixtureId }).then(
          (response) => ({ response }),
          (error) => ({ error })
        );
        const exit = await exitPromise;
        assert.notEqual(crashedPid, process.pid);
        assert.ok(exit.signal === 'SIGKILL' || exit.code !== 0, JSON.stringify(exit));
        const outcome = await attempt;
        assert.ok(outcome.error, 'The killed process still acknowledged the simulation');
        for (const socket of sockets) socket.close();

        const crashed = await readSaved(dbName, leagueId);
        const crashedFixture = crashed.fixtures.find((item) => item.fixtureId === fixtureId);
        assert.equal(crashed.fixtures.length, fixtureCount);
        if (point === 'before-claim') {
          assert.equal(crashedFixture.status, 'scheduled');
          assert.equal(crashedFixture.simulationSeed, null);
          assert.equal(crashedFixture.pendingResult, null);
          assert.equal(crashedFixture.result, null);
        } else if (point === 'after-claim' || point === 'after-simulation') {
          assert.equal(crashedFixture.status, 'simulating');
          assert.equal(Number.isInteger(crashedFixture.simulationSeed), true);
          assert.equal(crashedFixture.claimedHome.team.length, 11);
          assert.equal(crashedFixture.claimedAway.team.length, 11);
          assert.equal(crashedFixture.pendingResult, null);
          assert.equal(crashedFixture.result, null);
        } else if (point === 'after-pending') {
          assert.equal(crashedFixture.status, 'simulating');
          assert.ok(crashedFixture.pendingResult);
          assert.equal(crashedFixture.result, null);
          assert.deepEqual(
            {
              homeGoals: crashedFixture.pendingResult.homeGoals,
              awayGoals: crashedFixture.pendingResult.awayGoals,
              events: crashedFixture.pendingResult.events
            },
            {
              homeGoals: replay(crashedFixture).homeGoals,
              awayGoals: replay(crashedFixture).awayGoals,
              events: replay(crashedFixture).events
            }
          );
        } else {
          assert.equal(crashedFixture.status, 'completed');
          assert.ok(crashedFixture.result);
          assert.equal(crashed.league.currentRound, point === 'before-round-reconcile' ? 1 : 1);
          if (point === 'before-round-reconcile') assert.equal(crashed.league.status, 'active');
          if (point === 'after-complete') assert.equal(crashed.league.status, 'completed');
        }

        const expired = child;
        child = startServer(dbName, port, null);
        expired?.draft11RoomCleanup?.();
        if (expired) expired.draft11RoomCleanup = null;
        assert.notEqual(child.pid, crashedPid);
        await waitForHealth(child, port);
        const returning = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
        await new Promise((resolve) => returning.on('connect', resolve));
        const state = await ask(returning, 'league:state', memberAuth);
        assert.equal(state.success, true, state.message);
        assert.equal(state.league.fixtures.length, fixtureCount);
        const retry = await ask(returning, 'league:fixture:simulate', { ...memberAuth, fixtureId });
        assert.equal(retry.success, true, retry.message);
        const shown = retry.league.fixtures.find((item) => item.fixtureId === fixtureId);
        assert.ok(shown.result);
        const saved = await readSaved(dbName, leagueId);
        const recovered = saved.fixtures.find((item) => item.fixtureId === fixtureId);
        const expected = replay(recovered);
        assert.equal(recovered.status, 'completed');
        assert.equal(shown.result.homeGoals, expected.homeGoals);
        assert.equal(shown.result.awayGoals, expected.awayGoals);
        assert.deepEqual(shown.result.events, expected.events);
        if (point === 'after-claim' || point === 'after-simulation' || point === 'after-pending') {
          assert.equal(recovered.simulationSeed, crashedFixture.simulationSeed);
          assert.deepEqual(
            recovered.claimedHome.team.map((card) => card.id),
            crashedFixture.claimedHome.team.map((card) => card.id)
          );
        }
        if (point === 'after-pending') {
          assert.equal(recovered.result.homeGoals, crashedFixture.pendingResult.homeGoals);
          assert.equal(recovered.result.awayGoals, crashedFixture.pendingResult.awayGoals);
          assert.deepEqual(recovered.result.events, crashedFixture.pendingResult.events);
        }
        const expectedPoints = shown.result.homeGoals === shown.result.awayGoals ? 2 : 3;
        assert.equal(pointsOf(retry.league), expectedPoints);
        const second = await ask(returning, 'league:fixture:simulate', { ...memberAuth, fixtureId });
        assert.equal(second.alreadyComplete, true);
        assert.deepEqual(second.result, retry.result);
        assert.equal(pointsOf(second.league), expectedPoints);
        assert.equal(second.league.fixtures.length, fixtureCount);
        if (point === 'before-round-reconcile') {
          assert.equal(second.league.currentRound, 2);
          assert.equal(second.league.status, 'active');
          assert.equal(saved.league.currentRound, 2);
          assert.equal(second.league.fixtures.filter((item) => item.round === 2).length, 1);
        } else {
          assert.equal(second.league.status, 'completed');
          assert.equal(saved.league.status, 'completed');
        }
        const finalRows = await readSaved(dbName, leagueId);
        assert.equal(finalRows.fixtures.length, fixtureCount);
        assert.equal(finalRows.fixtures.filter((item) => item.status === 'completed').length, 1);
        returning.close();
      } finally {
        await stopServer(child);
        try {
          const connection = await openDb(dbName);
          await connection.dropDatabase();
          await connection.close();
        } catch {
          // The database may already be gone.
        }
      }
    });
  }
});
