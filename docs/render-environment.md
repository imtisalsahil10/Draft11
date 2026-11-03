# Render environment

Set these on the Render web service. Do not commit real values.

| Variable | Required | Value |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `MONGODB_URI` | yes | Rotated MongoDB Atlas connection string. Render is the only place it should exist. |
| `MONGODB_DB_NAME` | yes | `football-auction` |
| `ALLOWED_ORIGINS` | yes | Comma-separated frontend origins, for example `https://your-app.vercel.app`. No `*`. |
| `PORT` | provided | Render sets this. The server reads `process.env.PORT`. |

The frontend host needs the public API address, not the database URI:

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | Public Render origin |
| `VITE_SOCKET_IO_URL` | Same public Render origin |

Do not set these in production. They are ignored when `NODE_ENV=production`, and setting them is still a mistake:

- `DRAFT11_DIAGNOSTICS`
- `DRAFT11_TEST_CARD_LIMIT`
- `DRAFT11_TEST_ROOM_FILE`
- `DRAFT11_ROOM_FILE`
- `VITE_CARD_LAB`

`SOCKET_IO_CORS_ORIGIN=*` is not an allowlist. Production reads `ALLOWED_ORIGINS` only.

If Atlas cannot be reached, the process exits. `/health` returns 503 until MongoDB is connected.

The seat-token migration script is `node backend/scripts/migrate-seat-tokens.js`. It does nothing unless `CONFIRM_SEAT_TOKEN_MIGRATION=1`. Stop the server before running it, and only after a separate approval.
