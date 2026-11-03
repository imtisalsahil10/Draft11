/**
 * Live server and socket helpers for multi-room tests.
 * Each socket uses its own connection. Callers issue work with inParallel
 * so one room is not waited on before the next room starts.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNotDeveloperStore, createIsolatedRoomFile } from './isolated-rooms.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/**
 * Run worker(item) for every item without waiting for one item before starting the next.
 * maxInFlight is the number of workers that had started and not finished at the same time.
 */
export async function inParallel(items, worker) {
  let inFlight = 0;
  let maxInFlight = 0;
  const spans = await Promise.all(items.map(async (item) => {
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    const start = Date.now();
    try {
      const value = await worker(item);
      return { start, end: Date.now(), value };
    } finally {
      inFlight -= 1;
    }
  }));
  return { spans, maxInFlight };
}

export async function loadIo() {
  try {
    return (await import('socket.io-client')).io;
  } catch {
    return (await import('../../../frontend/node_modules/socket.io-client/build/esm/index.js')).io;
  }
}

export function ask(socket, event, payload = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function track(socket) {
  const events = [];
  const waiters = [];
  socket.onAny((name, payload) => {
    events.push({ name, payload, at: Date.now() });
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.name !== name || !waiter.predicate(payload)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    }
  });

  function waitFor(name, predicate = () => true, timeout = 20000, label = name) {
    const existing = events.find((event) => event.name === name && predicate(event.payload));
    if (existing) return Promise.resolve(existing.payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeout);
      waiters.push({ name, predicate, resolve, timer });
    });
  }

  return { events, waitFor };
}

export async function connectClient(io, url) {
  const socket = io(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 10000
  });
  const tracked = track(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connect timed out'));
    }, 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
  });
  return {
    socket,
    ...tracked,
    payloads: [],
    previousIds: [],
    seated: false,
    username: null,
    playerId: null,
    seatToken: null
  };
}

export async function createRooms(url, count) {
  const created = await inParallel(Array.from({ length: count }, (_, index) => index), async () => {
    const response = await fetch(`${url}/api/room/create`, { method: 'POST' });
    if (!response.ok) throw new Error(`Create room failed: ${response.status}`);
    const body = await response.json();
    if (!body.success || typeof body.roomCode !== 'string' || body.roomCode.length !== 6) {
      throw new Error(`Create room failed: ${JSON.stringify(body)}`);
    }
    return body.roomCode;
  });
  const codes = created.spans.map((span) => span.value);
  if (new Set(codes).size !== codes.length) throw new Error('Room codes collided');
  return { codes, maxInFlight: created.maxInFlight, spans: created.spans };
}

async function waitForHealth(child, url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.status !== 200 && response.status !== 503) continue;
      const body = await response.json().catch(() => null);
      if (body?.status === 'ok' || body?.status === 'unavailable') return;
    } catch {
      // Server is still starting.
    }
    await sleep(500);
  }
  throw new Error('Server did not become healthy');
}

export async function startLiveServer({ port, cardLimit = 4, env = {}, roomFile } = {}) {
  const logs = [];
  const owned = roomFile ? null : createIsolatedRoomFile();
  const file = assertNotDeveloperStore(roomFile || owned.file);
  let child;
  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        ...process.env,
        ...env,
        PORT: String(port),
        NODE_ENV: env.NODE_ENV || 'test',
        MONGODB_URI: Object.prototype.hasOwnProperty.call(env, 'MONGODB_URI') ? env.MONGODB_URI : '',
        REQUIRE_MONGO: env.REQUIRE_MONGO || '0',
        DRAFT11_DIAGNOSTICS: '1',
        SOCKET_IO_CORS_ORIGIN: '*',
        AUCTION_CARD_LIMIT: String(cardLimit),
        DRAFT11_TEST_CARD_LIMIT: '1',
        DRAFT11_TEST_ROOM_FILE: file
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.draft11RoomCleanup = owned ? owned.cleanup : null;
    const collect = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        logs.push(line);
        if (logs.length > 400) logs.shift();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(child, url);
    return { child, logs, url, port, roomFile: file };
  } catch (error) {
    if (child) await stopLiveServer(child);
    else owned?.cleanup();
    error.message += `\n${logs.slice(-40).join('\n')}`;
    throw error;
  }
}

export async function stopLiveServer(child) {
  const cleanup = child?.draft11RoomCleanup;
  try {
    if (child && child.exitCode == null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(5000).then(() => {
          if (child.exitCode == null) child.kill('SIGKILL');
        })
      ]);
    }
  } finally {
    if (child) child.draft11RoomCleanup = null;
    cleanup?.();
  }
}

export async function runtimeDiagnostics(url, { reset = false } = {}) {
  const response = await fetch(`${url}/api/diagnostics/runtime${reset ? '?reset=1' : ''}`);
  if (!response.ok) throw new Error(`Diagnostics failed: ${response.status}`);
  return response.json();
}

export async function healthLatency(url) {
  const start = Date.now();
  const response = await fetch(`${url}/health`);
  const ms = Date.now() - start;
  if (response.status !== 200 && response.status !== 503) throw new Error(`Health failed: ${response.status}`);
  await response.json();
  return ms;
}

export function cpuPercent(before, after, elapsedMs) {
  const usedUs = (after.cpu.user + after.cpu.system) - (before.cpu.user + before.cpu.system);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return (usedUs / 1000) / elapsedMs * 100;
}
