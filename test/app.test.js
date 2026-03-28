import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createApp, createConfig, normalizeModelsFromConfig, parseSSEText, summarizeMimoSSE } from "../src/app.js";

const CURL_SAMPLE = [
  "curl 'https://aistudio.xiaomimimo.com/open-apis/chat/conversation/list?xiaomichatbot_ph=quoted%2Btoken%3D%3D' \\",
  "  -H 'accept: */*' \\",
  "  -H 'accept-language: system' \\",
  "  -H 'origin: https://aistudio.xiaomimimo.com' \\",
  "  -H 'referer: https://aistudio.xiaomimimo.com/' \\",
  "  -H 'user-agent: Mozilla/5.0 Test Browser' \\",
  "  -H 'x-timezone: Asia/Shanghai' \\",
  "  -b 'serviceToken=\"abc123\"; userId=1; xiaomichatbot_ph=\"quoted+token==\"' \\",
  "  --data-raw '{\"pageInfo\":{\"pageNum\":1,\"pageSize\":20}}'",
].join("\n");

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
  assert.equal(defaults.defaultModel, "mimo-v2-pro");

  const overridden = createConfig({ HOST: "127.0.0.1", PORT: "4321" });
  assert.equal(overridden.host, "127.0.0.1");
  assert.equal(overridden.port, 4321);
});

test("createConfig normalizes quoted ph cookies and browser-like upstream defaults", () => {
  const config = createConfig({
    MIMO_BASE_URL: "https://aistudio.xiaomimimo.com/",
    MIMO_COOKIE: 'serviceToken=abc; userId=1; xiaomichatbot_ph="quoted+ph=="',
  });

  assert.equal(config.mimoBaseUrl, "https://aistudio.xiaomimimo.com");
  assert.equal(config.mimoOrigin, "https://aistudio.xiaomimimo.com");
  assert.equal(config.mimoReferer, "https://aistudio.xiaomimimo.com/");
  assert.equal(config.acceptLanguage, "system");
  assert.equal(config.phValue, "quoted+ph==");
  assert.match(config.userAgent, /Mozilla\/5\.0/);
});

test("createConfig extracts cookie and headers from full curl snippets", () => {
  const config = createConfig({
    MIMO_BASE_URL: "https://aistudio.xiaomimimo.com/",
    MIMO_COOKIE: CURL_SAMPLE,
  });

  assert.equal(config.cookie, 'serviceToken="abc123"; userId=1; xiaomichatbot_ph="quoted+token=="');
  assert.equal(config.phValue, "quoted+token==");
  assert.equal(config.acceptLanguage, "system");
  assert.equal(config.upstreamAccept, "*/*");
  assert.equal(config.timezone, "Asia/Shanghai");
  assert.equal(config.mimoOrigin, "https://aistudio.xiaomimimo.com");
  assert.equal(config.mimoReferer, "https://aistudio.xiaomimimo.com/");
  assert.equal(config.userAgent, "Mozilla/5.0 Test Browser");
});

test("normalizeModelsFromConfig supports both new and legacy MiMo bot config shapes", () => {
  const ngModels = normalizeModelsFromConfig({
    modelConfigListNg: [
      {
        name: "MiMo-V2-Pro",
        model: "mimo-v2-pro",
        isDefault: true,
        intro: { zh: "旗舰模型" },
        generation: { temperature: 0.7, topP: 0.9, maxTokens: 1234 },
        features: { webSearch: 0 },
      },
    ],
  });
  assert.equal(ngModels[0].id, "mimo-v2-pro");
  assert.equal(ngModels[0].default, true);
  assert.equal(ngModels[0].intro, "旗舰模型");

  const legacyModels = normalizeModelsFromConfig({
    modelConfigList: [
      {
        name: "mimo-v2-pro",
        model: "mimo-v2-pro",
        cnIntro: "适合深度思考",
        temperature: 0.8,
        topP: 0.95,
        thinkingDefaultOn: true,
        webSearchDefaultStatus: "disabled",
        enabledSceneTypeList: [],
      },
    ],
  });
  assert.equal(legacyModels[0].id, "mimo-v2-pro");
  assert.equal(legacyModels[0].intro, "适合深度思考");
  assert.equal(legacyModels[0].temperature, 0.8);
});

test("summarizeMimoSSE joins message chunks and extracts usage", () => {
  const events = parseSSEText([
    "id:test",
    "event:message",
    'data:{"type":"text","content":"你好"}',
    "",
    "id:test",
    "event:message",
    'data:{"type":"text","content":"，世界"}',
    "",
    "id:test",
    "event:usage",
    'data:{"promptTokens":12,"completionTokens":3,"totalTokens":15}',
  ].join("\n"));

  const summary = summarizeMimoSSE(events);
  assert.equal(summary.text, "你好，世界");
  assert.deepEqual(summary.usage, {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
  });
  assert.equal(summary.error, "");
});

test("GET / serves the dashboard", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /工作区导航/);
  assert.match(html, /data-tab-target="accounts"/);
  assert.match(html, /预览解析/);
  assert.match(html, /会话浏览器/);
  assert.match(html, /Responses 路由调试/);
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

test("account import strips quotes from xiaomichatbot_ph cookie values", async () => {
  const createResponse = await fetch(`${baseUrl}/api/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "quoted-ph",
      cookie: 'serviceToken=abc; userId=1; xiaomichatbot_ph="quoted+token=="',
      enabled: true,
    }),
  });

  assert.equal(createResponse.status, 200);

  const exportResponse = await fetch(`${baseUrl}/api/admin/export`);
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json();
  const stored = exported.data.accounts.accounts.find((item) => item.name === "quoted-ph");
  assert.ok(stored);
  assert.equal(stored.phValue, "quoted+token==");
});

test("account creation accepts full curl snippets and extracts the cookie", async () => {
  const createResponse = await fetch(`${baseUrl}/api/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "curl-import",
      cookie: CURL_SAMPLE,
      enabled: true,
    }),
  });

  assert.equal(createResponse.status, 200);
  const created = await createResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.data.name, "curl-import");

  const exportResponse = await fetch(`${baseUrl}/api/admin/export`);
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json();
  const stored = exported.data.accounts.accounts.find((item) => item.name === "curl-import");
  assert.ok(stored);
  assert.equal(stored.cookie, 'serviceToken="abc123"; userId=1; xiaomichatbot_ph="quoted+token=="');
  assert.equal(stored.phValue, "quoted+token==");
});

test("account input preview endpoint parses curl snippets before saving", async () => {
  const response = await fetch(`${baseUrl}/api/accounts/parse-input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: CURL_SAMPLE }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.source, "curl");
  assert.equal(payload.data.userId, "1");
  assert.equal(payload.data.phValue, "quoted+token==");
  assert.equal(payload.data.normalizedCookie, 'serviceToken="abc123"; userId=1; xiaomichatbot_ph="quoted+token=="');
  assert.equal(payload.data.headers.origin, "https://aistudio.xiaomimimo.com");
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
