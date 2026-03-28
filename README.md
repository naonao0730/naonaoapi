# MiMo OpenAI Bridge

An OpenAI-compatible bridge for Xiaomi MiMo Studio, with a built-in static dashboard for local inspection and testing.

## What is included

- `src/server.js`: Express bridge server
- `src/app.js`: main bridge app and routing logic
- `src/state.js`: persistent account pool and API key pool management
- `public/index.html`: no-build dashboard for runtime inspection, chat testing, file upload, and conversation browsing
- `.env.example`: environment template

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and fill in the MiMo credentials.

3. Start the server:

```bash
npm start
```

4. Open:

```text
http://localhost:3000
```

## Useful scripts

- `npm start`: start the bridge
- `npm run dev`: start with Node watch mode
- `npm run check`: run syntax checks
- `npm test`: run the minimal integration test suite

## Main endpoints

- `GET /health`
- `GET /api/config`
- `GET /api/examples`
- `GET /api/accounts`
- `POST /api/accounts`
- `PATCH /api/accounts/:accountId`
- `DELETE /api/accounts/:accountId`
- `POST /api/accounts/strategy`
- `POST /api/accounts/active`
- `POST /api/accounts/:accountId/check`
- `GET /api/keys`
- `POST /api/keys`
- `PATCH /api/keys/:keyId`
- `DELETE /api/keys/:keyId`
- `GET /api/admin/export`
- `POST /api/admin/import`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /api/files/upload`
- `GET /api/tools/conversations`
- `POST /api/tools/dialogs`

## Notes

- The dashboard is static and does not require a frontend build step.
- The dashboard includes account pool management, API key management, a chat playground, and a separate Responses API lab.
- `ENABLE_EXEC_TOOL=false` by default. Only enable local command execution if you trust the environment.
- `DEFAULT_AUTO_EXECUTE_LOCAL_TOOLS=true` by default, so bridge-managed tools can run server-side and return the final answer without relying on the client to perform a tool loop.
- Clients can still override tool execution per request with `auto_execute_local_tools` or `metadata.auto_execute_local_tools`.
- Streaming remains available in Mode B: the bridge opens the SSE response immediately, keeps it alive during hidden tool rounds, and streams the final assistant output after the server-side tool loop completes.
- When at least one managed bridge API key is enabled, requests to `/v1/*` must include `Authorization: Bearer <key>`.
- Managed MiMo accounts can be added directly by cookie, and the bridge can route them in `round_robin` or `single` mode.
- Accounts track success/failure counts, last error, and consecutive failures. When failures reach `ACCOUNT_FAILURE_THRESHOLD`, the account enters cooldown for `ACCOUNT_COOLDOWN_MS`.
- The dashboard can export and import the full managed account/key snapshot in `replace` or `merge` mode.
- `/api/config` exposes the current persistence mode, so you can confirm whether the bridge is using `file` or fallback `memory`.
