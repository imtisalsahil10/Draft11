import { defineConfig, devices } from '@playwright/test';

const backendPort = process.env.E2E_BACKEND_PORT || '3025';
const frontendPort = process.env.E2E_FRONTEND_PORT || '5199';

export default defineConfig({
  testDir: './e2e',
  timeout: 240000,
  workers: 1,
  expect: { timeout: 20000 },
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${frontendPort}`,
    trace: 'on-first-retry'
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } }
  ],
  webServer: [
    {
      command: 'node server.js',
      cwd: './backend',
      port: Number(backendPort),
      timeout: 120000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        PORT: backendPort,
        NODE_ENV: 'test',
        REQUIRE_MONGO: '0',
        MONGODB_URI: '',
        AUCTION_CARD_LIMIT: '22',
        DRAFT11_TEST_CARD_LIMIT: '1',
        AUCTION_TIMER_MS: '2500',
        AUCTION_GAP_MS: '100',
        DRAFT11_TEST_ROOM_FILE: '../data/local-test-rooms/e2e-rooms.json',
        SOCKET_IO_CORS_ORIGIN: `http://localhost:${frontendPort}`
      }
    },
    {
      command: `npm run dev -- --host localhost --port ${frontendPort} --strictPort`,
      cwd: './frontend',
      url: `http://localhost:${frontendPort}`,
      timeout: 120000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VITE_API_URL: `http://localhost:${backendPort}`,
        VITE_SOCKET_IO_URL: `http://localhost:${backendPort}`,
        VITE_CARD_LAB: '1'
      }
    }
  ]
});
