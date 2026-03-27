import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createApp, createConfig } from "../src/app.js";

let server;
let baseUrl;
let tempDir;

test.before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mimo-bridge-"));
  const config = createConfig({
    PORT: "0",
    MIMO_BASE_URL: "https://example.invalid",
    DEFAULT_MODEL: "mimo-v2-flash-studio",
    ENABLE_EXEC_TOOL: "false",
    ACCOUNT_STORE_FILE: path.join(tempDir, "accounts.json"),
    KEY_STORE_FILE: path.join(tempDir, "keys.json"),
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
  rmSync(tempDir, { recursive: true, force: true });
});

test("GET /health returns ok", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "mimo-openai-bridge");
});

test("createConfig defaults to a deployment-safe host and allows overrides", () => {
  const defaults = createConfig({});
  assert.equal(defaults.host, "0.0.0.0");

  const overridden = createConfig({ HOST: "127.0.0.1", PORT: "4321" });
  assert.equal(overridden.host, "127.0.0.1");
  assert.equal(overridden.port, 4321);
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

test("account pool supports cookie-based account creation and strategy updates", async () => {
  const createResponse = await fetch(`${baseUrl}/api/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "primary",
      cookie: "serviceToken=abc; xiaomichatbot_ph=ph123456; userId=1",
      enabled: true,
    }),
  });

  assert.equal(createResponse.status, 200);
  const created = await createResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.data.name, "primary");
  assert.equal(created.accounts.enabled, 1);

  const strategyResponse = await fetch(`${baseUrl}/api/accounts/strategy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ routingStrategy: "single" }),
  });

  assert.equal(strategyResponse.status, 200);
  const strategy = await strategyResponse.json();
  assert.equal(strategy.accounts.routingStrategy, "single");
  assert.equal(strategy.accounts.accounts[0].status, "healthy");
});

test("admin export and import round-trip managed state", async () => {
  const exportResponse = await fetch(`${baseUrl}/api/admin/export`);
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json();
  assert.equal(exported.ok, true);
  assert.ok(Array.isArray(exported.data.accounts.accounts));

  const importResponse = await fetch(`${baseUrl}/api/admin/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "merge",
      data: exported.data,
    }),
  });
  assert.equal(importResponse.status, 200);
  const imported = await importResponse.json();
  assert.equal(imported.ok, true);
  assert.ok(imported.accounts.total >= 1);
});

test("enabled bridge keys protect /v1 routes", async () => {
  const createKeyResponse = await fetch(`${baseUrl}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test-client", key: "bridge_test_key", enabled: true }),
  });

  assert.equal(createKeyResponse.status, 200);

  const unauthenticated = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(unauthenticated.status, 401);

  const authenticated = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer bridge_test_key",
    },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(authenticated.status, 400);
});

test("app falls back to memory mode when state files are not writable", async () => {
  const config = createConfig({
    PORT: "0",
    MIMO_BASE_URL: "https://example.invalid",
    ACCOUNT_STORE_FILE: "?:\\invalid\\accounts.json",
    KEY_STORE_FILE: "?:\\invalid\\keys.json",
  });

  const app = createApp(config);
  const tempServer = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const address = tempServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/config`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.config.persistence.mode, "memory");
  } finally {
    await new Promise((resolve, reject) => {
      tempServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
