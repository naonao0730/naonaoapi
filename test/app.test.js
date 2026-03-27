import test from "node:test";
import assert from "node:assert/strict";
import { createApp, createConfig } from "../src/app.js";

let server;
let baseUrl;

test.before(async () => {
  const config = createConfig({
    PORT: "0",
    MIMO_BASE_URL: "https://example.invalid",
    DEFAULT_MODEL: "mimo-v2-flash-studio",
    ENABLE_EXEC_TOOL: "false",
  });

  const app = createApp(config);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("GET /health returns ok", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "mimo-openai-bridge");
});

test("GET / serves the dashboard", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Conversation Explorer/);
  assert.match(html, /Responses Lab/);
});

test("POST /v1/chat/completions validates empty messages", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.type, "invalid_request_error");
  assert.match(payload.error.message, /messages must not be empty/);
});

test("POST /v1/responses validates empty input", async () => {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "" }),
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.type, "invalid_request_error");
  assert.match(payload.error.message, /input must not be empty/);
});
