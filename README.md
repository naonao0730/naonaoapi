# MiMo OpenAI Bridge

An OpenAI-compatible bridge for Xiaomi MiMo Studio, with a built-in static dashboard for local inspection and testing.

## What is included

- `src/server.js`: Express bridge server
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
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /api/files/upload`
- `GET /api/tools/conversations`
- `POST /api/tools/dialogs`

## Notes

- The dashboard is static and does not require a frontend build step.
- The dashboard includes a chat playground and a separate Responses API lab.
- `ENABLE_EXEC_TOOL=false` by default. Only enable local command execution if you trust the environment.
- The bridge can expose tool definitions and optionally auto-execute local tools through request metadata.
