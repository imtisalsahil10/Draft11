/**
 * Ramp concurrent rooms and socket clients.
 * Each stage adds rooms to the rooms already running, then syncs every client
 * together. The numbers describe this run. They are not a maximum capacity.
 */

import {
  ask,
  connectClient,
  cpuPercent,
  createRooms,
  healthLatency,
  inParallel,
  loadIo,
  percentile,
  runtimeDiagnostics,
  sleep,
  startLiveServer,
  stopLiveServer
} from '../tests/support/live-server.js';

const STAGES = [4, 8, 12, 16];
const SEATS = 3;
const PORT = 3102;

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function lastPresented(client) {
  for (let index = client.events.length - 1; index >= 0; index -= 1) {
    if (client.events[index].name === 'auction:card-presented') return client.events[index].payload;
  }
  return null;
}

async function waitForQuiet(url) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 8000) {
    last = await runtimeDiagnostics(url);
    if (last.auctions === 0 && last.biddingTimers === 0 && last.transitionTimers === 0) return last;
    await sleep(100);
  }
  return last;
}

async function main() {
  const server = await startLiveServer({ port: PORT, cardLimit: 4 });
  const io = await loadIo();
  const live = [];
  const report = [];
  let stopReason = null;
  let cleanup = null;
  const baseline = await runtimeDiagnostics(server.url);

  try {
    for (const target of STAGES) {
      const stageStarted = Date.now();
      const add = target - live.length;
      try {
        const created = await createRooms(server.url, add);
        if (created.maxInFlight !== add) {
          throw new Error(`Room creates in flight ${created.maxInFlight}, expected ${add}`);
        }
        const rooms = created.codes.map((code, offset) => ({
          code,
          index: live.length + offset,
          clients: []
        }));

        await Promise.all(rooms.map(async (room) => {
          const joined = await inParallel(Array.from({ length: SEATS }, (_, seat) => seat), async (seat) => {
            const client = await connectClient(io, server.url);
            const username = `l${String(room.index).padStart(2, '0')}s${seat}`;
            const response = await ask(client.socket, 'room:join', { username, roomCode: room.code });
            if (!response.success) throw new Error(`join ${username}: ${response.message || response.error}`);
            client.username = username;
            client.playerId = response.playerId;
            client.seatToken = response.seatToken;
            client.seated = true;
            return client;
          });
          if (joined.maxInFlight !== SEATS) throw new Error(`${room.code} seats were not in flight together`);
          room.clients = joined.spans.map((span) => span.value);
        }));

        const starts = await inParallel(rooms, async (room) => {
          const response = await ask(room.clients[0].socket, 'room:start-auction', {});
          if (!response.success) throw new Error(`start ${room.code}: ${response.message || response.error}`);
          return response;
        });
        if (starts.maxInFlight !== rooms.length) {
          throw new Error(`Auction starts in flight ${starts.maxInFlight}, expected ${rooms.length}`);
        }
        await Promise.all(rooms.flatMap((room) => room.clients.map((client) => (
          client.waitFor('auction:card-presented', () => true, 15000, client.username)
        ))));

        const bids = await inParallel(rooms, async (room) => {
          const presented = lastPresented(room.clients[0]);
          if (!presented?.minimumBid) throw new Error(`${room.code} has no card`);
          const response = await ask(room.clients[0].socket, 'auction:bid', { bidAmount: presented.minimumBid });
          if (!response.success) throw new Error(`bid ${room.code}: ${response.message || response.error}`);
          return response;
        });
        if (bids.maxInFlight !== rooms.length) {
          throw new Error(`Bids in flight ${bids.maxInFlight}, expected ${rooms.length}`);
        }

        live.push(...rooms);
        const clients = live.flatMap((room) => room.clients);
        const before = await runtimeDiagnostics(server.url);
        const sampleStarted = Date.now();
        const syncLatencies = [];
        const until = Date.now() + 1000;
        do {
          const wave = await inParallel(clients, async (client) => {
            const response = await ask(client.socket, 'auction:sync', {});
            if (!response.success) throw new Error(`sync ${client.username}: ${response.error || response.message}`);
            return response;
          });
          if (wave.maxInFlight !== clients.length) {
            throw new Error(`Sync clients in flight ${wave.maxInFlight}, expected ${clients.length}`);
          }
          for (const span of wave.spans) syncLatencies.push(span.end - span.start);
        } while (Date.now() < until);

        const health = [];
        for (let sample = 0; sample < 10; sample += 1) health.push(await healthLatency(server.url));
        const after = await runtimeDiagnostics(server.url);
        const elapsed = Date.now() - sampleStarted;
        const row = {
          rooms: live.length,
          clients: clients.length,
          bidP50Ms: percentile(bids.spans.map((span) => span.end - span.start), 50),
          bidP95Ms: percentile(bids.spans.map((span) => span.end - span.start), 95),
          bidMaxMs: percentile(bids.spans.map((span) => span.end - span.start), 100),
          syncP50Ms: percentile(syncLatencies, 50),
          syncP95Ms: percentile(syncLatencies, 95),
          syncMaxMs: percentile(syncLatencies, 100),
          syncSamples: syncLatencies.length,
          healthP95Ms: percentile(health, 95),
          healthMaxMs: Math.max(...health),
          rssMB: round(after.memory.rss / 1048576),
          heapMB: round(after.memory.heapUsed / 1048576),
          rssDeltaMB: round((after.memory.rss - baseline.memory.rss) / 1048576),
          cpuPercent: round(cpuPercent(before, after, elapsed)),
          sampleMs: elapsed,
          serverMaxInFlight: after.concurrency.maxInFlight,
          errors: 0,
          stageMs: Date.now() - stageStarted
        };
        report.push(row);
        if (row.rssMB > 800) {
          stopReason = `stopped after ${row.rooms} rooms because RSS ${row.rssMB} MB crossed the 800 MB measurement budget`;
          break;
        }
        if (row.stageMs > 60000) {
          stopReason = `stopped after ${row.rooms} rooms because the stage took ${row.stageMs} ms, over the 60 s measurement budget`;
          break;
        }
      } catch (error) {
        stopReason = `stopped while moving to ${target} rooms: ${error.message}`;
        report.push({
          rooms: target,
          clients: target * SEATS,
          errors: 1,
          error: error.message,
          stageMs: Date.now() - stageStarted
        });
        break;
      }
    }

    const seated = live.flatMap((room) => room.clients).filter((client) => client.seated && client.socket.connected);
    await Promise.all(seated.map(async (client) => {
      client.socket.emit('room:leave');
      client.seated = false;
    }));
    cleanup = await waitForQuiet(server.url);
  } finally {
    for (const room of live) {
      for (const client of room.clients) client.socket?.disconnect();
    }
    await stopLiveServer(server.child);
  }

  const completed = report.filter((row) => row.errors === 0);
  console.log('DRAFT11_LOAD rooms clients bidP50 bidP95 syncP50 syncP95 healthP95 rssMB heapMB cpu% errors stageMs');
  for (const row of report) {
    if (row.errors) {
      console.log(`${row.rooms} ${row.clients} error ${row.error}`);
      continue;
    }
    console.log([
      row.rooms,
      row.clients,
      row.bidP50Ms,
      row.bidP95Ms,
      row.syncP50Ms,
      row.syncP95Ms,
      row.healthP95Ms,
      row.rssMB,
      row.heapMB,
      row.cpuPercent,
      row.errors,
      row.stageMs
    ].join(' '));
  }
  console.log(`DRAFT11_LOAD_JSON ${JSON.stringify({
    stages: STAGES,
    seatsPerRoom: SEATS,
    completed,
    stopReason,
    cleanup,
    baselineRssMB: round(baseline.memory.rss / 1048576)
  })}`);
  console.log('This ramp does not establish a maximum supported capacity.');
  if (stopReason) console.log(stopReason);

  const cleaned = cleanup && cleanup.auctions === 0 && cleanup.biddingTimers === 0 && cleanup.transitionTimers === 0;
  if (!cleaned) {
    console.error('Timers were still armed after the load clients left.');
    process.exitCode = 1;
  }
  if (completed.length !== STAGES.length || stopReason) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
