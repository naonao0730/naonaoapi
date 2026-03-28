import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  authenticateApiKey,
  createAccount,
  createApiKey,
  createRuntimeState,
  deleteAccount,
  deleteApiKey,
  exportRuntimeState,
  extractCookieValue,
  getAccountsView,
  getKeysView,
  hasEnabledApiKeys,
  hasUpstreamCredentials,
  importRuntimeState,
  patchAccount,
  patchApiKey,
  pickUpstreamAccount,
  parseCredentialInput,
  recordAccountFailure,
  recordAccountSuccess,
  setActiveAccount,
  setRoutingStrategy,
  normalizeCookieValue,
} from "./state.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, "..");
export const PUBLIC_DIR = path.join(ROOT, "public");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

loadEnv(path.join(ROOT, ".env"));

export function createConfig(env = process.env) {
  const mimoBaseUrl = (env.MIMO_BASE_URL || "https://aistudio.xiaomimimo.com").replace(/\/$/, "");
  const upstreamInput = parseCredentialInput(env.MIMO_COOKIE || "");
  return {
    host: env.HOST || "0.0.0.0",
    port: Number(env.PORT || 3000),
    mimoBaseUrl,
    mimoOrigin: env.MIMO_ORIGIN || upstreamInput.headers.origin || mimoBaseUrl,
    mimoReferer: env.MIMO_REFERER || upstreamInput.headers.referer || `${mimoBaseUrl}/`,
    cookie: upstreamInput.cookie,
    phValue: normalizeCookieValue(env.MIMO_PH_VALUE) || upstreamInput.phValue || extractCookieValue(upstreamInput.cookie || "", "xiaomichatbot_ph") || "",
    acceptLanguage: env.MIMO_ACCEPT_LANGUAGE || upstreamInput.headers["accept-language"] || "system",
    upstreamAccept: env.MIMO_UPSTREAM_ACCEPT || upstreamInput.headers.accept || "*/*",
    userAgent: env.MIMO_USER_AGENT || upstreamInput.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    timezone: env.MIMO_TIMEZONE || upstreamInput.headers["x-timezone"] || "Asia/Shanghai",
    defaultModel: env.DEFAULT_MODEL || "mimo-v2-pro",
    defaultEnableThinking: String(env.DEFAULT_ENABLE_THINKING || "true").toLowerCase() === "true",
    defaultWebSearchMode: env.DEFAULT_WEB_SEARCH_MODE || "disabled",
    maxToolRounds: Number(env.MAX_TOOL_ROUNDS || 4),
    enableExecTool: String(env.ENABLE_EXEC_TOOL || "false").toLowerCase() === "true",
    execToolCwd: env.EXEC_TOOL_CWD || ROOT,
    accountStoreFile: env.ACCOUNT_STORE_FILE || path.join(ROOT, "data", "accounts.json"),
    keyStoreFile: env.KEY_STORE_FILE || path.join(ROOT, "data", "bridge-keys.json"),
    accountRoutingStrategy: env.ACCOUNT_ROUTING_STRATEGY || "round_robin",
    accountFailureThreshold: Number(env.ACCOUNT_FAILURE_THRESHOLD || 3),
    accountCooldownMs: Number(env.ACCOUNT_COOLDOWN_MS || 300000),
  };
}

export const LOCAL_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_user_info",
      description: "Get the current MiMo account profile.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_models",
      description: "List available MiMo models and capabilities.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_conversations",
      description: "List conversations, optionally filtered by a search keyword.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Conversation search keyword." },
          pageNum: { type: "number", description: "Page number. Default: 1." },
          pageSize: { type: "number", description: "Page size. Default: 20." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dialogs",
      description: "List dialog messages for a specific conversationId.",
      parameters: {
        type: "object",
        properties: {
          conversationId: { type: "string", description: "Conversation ID." },
          endId: { type: "number", description: "Optional pagination end ID." },
          pageNum: { type: "number", description: "Page number. Default: 1." },
          pageSize: { type: "number", description: "Page size. Default: 10." },
        },
        required: ["conversationId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exec_command",
      description: "Run a local shell command. Only available when ENABLE_EXEC_TOOL=true.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

const TOOL_SYSTEM_PROMPT = [
  "You are working through an OpenAI-compatible bridge.",
  "If you need tools, do not explain them in prose. Output one or more XML-wrapped tool call blocks only.",
  "The required format is: <tool_call>{\"id\":\"call_xxx\",\"name\":\"tool_name\",\"arguments\":{}}</tool_call>",
  "You may output multiple <tool_call> blocks in sequence, but do not add extra explanation around them.",
  "After tool results are provided, continue the answer normally and do not repeat old tool calls.",
].join("\n");

export function createApp(config = createConfig()) {
  const state = createRuntimeState(config);
  config.runtimeState = state;
  const app = express();
  app.locals.runtimeState = state;
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(PUBLIC_DIR));

  app.use(async (_req, res, next) => {
    try {
      await state.ready;
      next();
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  app.use("/v1", (req, res, next) => {
    if (!hasEnabledApiKeys(state)) {
      return next();
    }

    const token = extractBearerToken(req.headers.authorization);
    const apiKey = authenticateApiKey(state, token);
    if (!apiKey) {
      return sendOpenAIError(res, new Error("A valid Bearer API key is required"), 401, "authentication_error");
    }

    req.authenticatedKey = apiKey;
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "mimo-openai-bridge", time: new Date().toISOString() });
  });

  app.get("/api/config", async (_req, res) => {
    try {
      let models = [];
      let upstreamError = null;
      if (hasUpstreamCredentials(config, state)) {
        try {
          const auth = pickUpstreamAccount(state, config);
          const botConfig = await getBotConfig(config, auth);
          models = normalizeModelsFromConfig(botConfig);
        } catch (error) {
          upstreamError = formatError(error);
        }
      }

      const resolvedDefaultModel = resolvePreferredModelId(models, config.defaultModel);

      res.json({
        ok: true,
        config: {
          baseUrl: config.mimoBaseUrl,
          hasCookie: Boolean(config.cookie),
          hasPhValue: Boolean(config.phValue),
          defaultModel: resolvedDefaultModel,
          enableExecTool: config.enableExecTool,
          models,
          localTools: getEnabledLocalTools(config),
          upstreamReady: hasUpstreamCredentials(config, state),
          upstreamError,
          accountPool: getAccountsView(state, config),
          keyPool: getKeysView(state),
          persistence: state.persistence,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  app.get("/api/tool-definitions", (_req, res) => {
    res.json({ ok: true, data: getEnabledLocalTools(config) });
  });

  app.get("/api/accounts", (_req, res) => {
    res.json({ ok: true, data: getAccountsView(state, config) });
  });

  app.post("/api/accounts/parse-input", (req, res) => {
    try {
      const input = String(req.body?.input || "").trim();
      if (!input) {
        return res.status(400).json({ ok: false, error: "input must not be empty" });
      }

      res.json({
        ok: true,
        data: buildAccountInputPreview(input),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.post("/api/accounts", (req, res) => {
    try {
      const account = createAccount(state, req.body || {});
      res.json({ ok: true, data: account, accounts: getAccountsView(state, config) });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.patch("/api/accounts/:accountId", (req, res) => {
    try {
      const account = patchAccount(state, req.params.accountId, req.body || {});
      res.json({ ok: true, data: account, accounts: getAccountsView(state, config) });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.delete("/api/accounts/:accountId", (req, res) => {
    try {
      deleteAccount(state, req.params.accountId);
      res.json({ ok: true, accounts: getAccountsView(state, config) });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.post("/api/accounts/strategy", (req, res) => {
    try {
      const routingStrategy = setRoutingStrategy(state, req.body?.routingStrategy);
      res.json({ ok: true, data: { routingStrategy }, accounts: getAccountsView(state, config) });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.post("/api/accounts/active", (req, res) => {
    try {
      const activeAccountId = setActiveAccount(state, req.body?.accountId || null);
      res.json({ ok: true, data: { activeAccountId }, accounts: getAccountsView(state, config) });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.post("/api/accounts/:accountId/check", async (req, res) => {
    try {
      const account = state.accountsStore.accounts.find((item) => item.id === req.params.accountId);
      if (!account) {
        return res.status(404).json({ ok: false, error: "account not found" });
      }

      const auth = {
        source: "pool",
        accountId: account.id,
        name: account.name,
        cookie: account.cookie,
        phValue: account.phValue,
      };
      const data = await mimoRequest(config, auth, "GET", "/open-apis/user/mi/get");
      res.json({ ok: true, data, accounts: getAccountsView(state, config) });
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error), accounts: getAccountsView(state, config) });
    }
  });

  app.get("/api/keys", (_req, res) => {
    res.json({ ok: true, data: getKeysView(state) });
  });

  app.post("/api/keys", (req, res) => {
    try {
      const result = createApiKey(state, req.body || {});
      res.json({ ok: true, data: result, keys: getKeysView(state) });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.patch("/api/keys/:keyId", (req, res) => {
    try {
      const key = patchApiKey(state, req.params.keyId, req.body || {});
      res.json({ ok: true, data: key, keys: getKeysView(state) });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.delete("/api/keys/:keyId", (req, res) => {
    try {
      deleteApiKey(state, req.params.keyId);
      res.json({ ok: true, keys: getKeysView(state) });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.get("/api/admin/export", (_req, res) => {
    res.json({ ok: true, data: exportRuntimeState(state) });
  });

  app.post("/api/admin/import", (req, res) => {
    try {
      importRuntimeState(state, req.body?.data || req.body || {}, req.body?.mode || "replace");
      res.json({
        ok: true,
        accounts: getAccountsView(state, config),
        keys: getKeysView(state),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: formatError(error) });
    }
  });

  app.get("/api/examples", (_req, res) => {
    res.json({
      ok: true,
      data: {
        curl: [
          `curl http://localhost:${config.port}/v1/models`,
          `curl http://localhost:${config.port}/v1/chat/completions -H "Content-Type: application/json" -d "{\\"model\\":\\"${config.defaultModel}\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Hello, introduce yourself briefly.\\"}]}"`,
        ],
        javascript: {
          baseURL: `http://localhost:${config.port}/v1`,
          example: `const resp = await fetch("http://localhost:${config.port}/v1/chat/completions", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({\n    model: "${config.defaultModel}",\n    messages: [{ role: "user", content: "Hello" }]\n  })\n});\nconsole.log(await resp.json());`,
        },
      },
    });
  });

  app.get("/v1/models", async (_req, res) => {
    try {
      const auth = pickUpstreamAccount(state, config);
      const botConfig = await getBotConfig(config, auth);
      const data = normalizeModelsFromConfig(botConfig).map((item) => ({
        id: item.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "xiaomi-mimo",
        permission: [],
        root: item.id,
        parent: null,
        meta: item,
      }));
      res.json({ object: "list", data });
    } catch (error) {
      sendOpenAIError(res, error, 500);
    }
  });

  app.post("/v1/chat/completions", async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.messages) || !body.messages.length) {
        return sendOpenAIError(res, new Error("messages must not be empty"), 400, "invalid_request_error");
      }

      if (body.stream) {
        const auth = pickUpstreamAccount(state, config);
        return handleStreamingChatCompletion(res, body, config, auth);
      }

      const auth = pickUpstreamAccount(state, config);
      const result = await runCompletionLoop(body, config, auth);
      res.json(toChatCompletionResponse(result, body.model || config.defaultModel));
    } catch (error) {
      sendOpenAIError(res, error, 500);
    }
  });

  app.post("/v1/responses", async (req, res) => {
    try {
      const body = req.body || {};
      const messages = responsesInputToMessages(body.input);
      if (!messages.length) {
        return sendOpenAIError(res, new Error("input must not be empty"), 400, "invalid_request_error");
      }

      const auth = pickUpstreamAccount(state, config);
      const result = await runCompletionLoop({
        model: body.model,
        messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
        temperature: body.temperature,
        top_p: body.top_p,
        max_tokens: body.max_output_tokens,
        metadata: body.metadata,
        enable_thinking: body.reasoning?.effort ? true : undefined,
      }, config, auth);

      const output = result.message.tool_calls?.length
        ? result.message.tool_calls.map((call) => ({
            id: call.id,
            type: "function_call",
            status: "completed",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          }))
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: result.message.content || "" }] }];

      res.json({
        id: `resp_${randomId(24)}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: body.model || config.defaultModel,
        output,
        usage: result.usage,
        metadata: body.metadata || {},
      });
    } catch (error) {
      sendOpenAIError(res, error, 500);
    }
  });

  app.get("/api/tools/user-info", async (_req, res) => {
    try {
      const auth = pickUpstreamAccount(state, config);
      const data = await mimoRequest(config, auth, "GET", "/open-apis/user/mi/get");
      res.json({ ok: true, data });
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  app.get("/api/tools/conversations", async (req, res) => {
    try {
      const auth = pickUpstreamAccount(state, config);
      const data = await mimoRequest(config, auth, "POST", "/open-apis/chat/conversation/list", {
        queryParam: { search: String(req.query.search || "") || undefined },
        pageInfo: {
          pageNum: Number(req.query.pageNum || 1),
          pageSize: Number(req.query.pageSize || 20),
        },
      });
      res.json({ ok: true, data });
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  app.post("/api/tools/dialogs", async (req, res) => {
    try {
      const { conversationId, endId, pageNum = 1, pageSize = 10 } = req.body || {};
      if (!conversationId) {
        return res.status(400).json({ ok: false, error: "conversationId is required" });
      }

      const auth = pickUpstreamAccount(state, config);
      const data = await mimoRequest(config, auth, "POST", "/open-apis/chat/dialog/list", {
        queryParam: { conversationId, endId },
        pageInfo: { pageNum: Number(pageNum), pageSize: Number(pageSize) },
      });
      res.json({ ok: true, data });
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  app.get("/api/tools/models", async (_req, res) => {
    try {
      const auth = pickUpstreamAccount(state, config);
      const botConfig = await getBotConfig(config, auth);
      res.json({ ok: true, data: normalizeModelsFromConfig(botConfig) });
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  app.post("/api/tools/exec", async (req, res) => {
    try {
      if (!config.enableExecTool) {
        return res.status(403).json({ ok: false, error: "Local exec tool is disabled. Set ENABLE_EXEC_TOOL=true in .env to enable it." });
      }

      const command = String(req.body?.command || "").trim();
      if (!command) {
        return res.status(400).json({ ok: false, error: "command must not be empty" });
      }

      const { stdout, stderr } = await execAsync(command, {
        cwd: path.resolve(ROOT, config.execToolCwd),
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        shell: true,
      });

      res.json({ ok: true, data: { command, stdout, stderr } });
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  app.post("/api/files/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "No file uploaded" });
      }

      const md5 = crypto.createHash("md5").update(req.file.buffer).digest("hex");
      const auth = pickUpstreamAccount(state, config);
      const uploadInfo = await mimoRequest(config, auth, "POST", "/open-apis/resource/genUploadInfo", {
        fileName: req.file.originalname,
        fileContentMd5: md5,
      });

      const putResp = await fetch(uploadInfo.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "content-md5": md5,
        },
        body: req.file.buffer,
      });

      if (!putResp.ok) {
        throw new Error(`File upload failed: HTTP ${putResp.status}`);
      }

      let parsed = null;
      const shouldParse = String(req.body.parse || "true").toLowerCase() !== "false";
      const model = String(req.body.model || config.defaultModel);
      if (shouldParse) {
        parsed = await mimoRequest(config, auth, "POST", "/open-apis/resource/parse", null, {
          fileUrl: uploadInfo.resourceUrl,
          objectName: uploadInfo.objectName,
          model,
        });
      }

      const mediaType = inferMediaType(req.file.originalname, req.file.mimetype);
      res.json({
        ok: true,
        data: {
          name: req.file.originalname,
          size: req.file.size,
          mediaType,
          fileUrl: uploadInfo.resourceUrl,
          objectName: uploadInfo.objectName,
          uploadProgress: 100,
          status: "completed",
          parsed,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: formatError(error) });
    }
  });

  app.use((req, res, next) => {
    if (req.path.startsWith("/v1/") || req.path.startsWith("/api/") || req.path === "/health") {
      return next();
    }
    if (path.extname(req.path)) {
      return next();
    }
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  app.use((req, res) => {
    if (req.path.startsWith("/v1/") || req.path.startsWith("/api/") || req.path === "/health") {
      return res.status(404).json({ ok: false, error: "Not found" });
    }
    res.status(404).send("Not found");
  });

  return app;
}

export function startServer(config = createConfig()) {
  const app = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`MiMo OpenAI Bridge listening on http://${config.host}:${config.port}`);
    if (config.runtimeState?.persistence?.mode === "memory") {
      console.warn(`State persistence fallback: memory mode (${config.runtimeState.persistence.lastError})`);
    }
  });
  server.on("error", (error) => {
    console.error("MiMo OpenAI Bridge failed to start:", error);
  });
  return { app, server, config };
}

async function handleStreamingChatCompletion(res, body, config, auth) {
  const model = body.model || config.defaultModel;
  const completionId = `chatcmpl_${randomId(24)}`;
  const created = Math.floor(Date.now() / 1000);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const sendChunk = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sendChunk({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  const result = await runCompletionLoop(body, config, auth);

  if (result.message.tool_calls?.length) {
    result.message.tool_calls.forEach((call, index) => {
      sendChunk({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.function.name,
                arguments: call.function.arguments,
              },
            }],
          },
          finish_reason: null,
        }],
      });
    });
  } else {
    const chunks = splitForStreaming(result.message.content || "");
    for (const part of chunks) {
      sendChunk({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
      });
    }
  }

  sendChunk({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: result.message.tool_calls?.length ? "tool_calls" : "stop" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function runCompletionLoop(body, config, auth) {
  const workingMessages = JSON.parse(JSON.stringify(body.messages || []));
  const providedTools = normalizeTools(body.tools || []);
  const baseTools = providedTools.length ? providedTools : getEnabledLocalTools(config);
  const tools = applyToolChoice(baseTools, body.tool_choice);
  const maxRounds = Math.max(1, config.maxToolRounds);
  const autoExecuteLocalTools = Boolean(body.metadata?.auto_execute_local_tools);
  const conversationId = randomId(32);
  let latestText = "";

  for (let round = 0; round < maxRounds; round += 1) {
    const prompt = buildPromptFromMessages(workingMessages, tools);
    const latestUser = getLatestUserMessage(workingMessages);
    const upstream = await requestMimoChat(config, auth, {
      model: body.model || config.defaultModel,
      temperature: body.temperature,
      topP: body.top_p,
      prompt,
      multiMedias: latestUser.multiMedias,
      enableThinking: resolveEnableThinking(body, config),
      webSearchMode: resolveWebSearchMode(body, config),
      conversationId,
    });

    latestText = upstream.finalText;
    const parsed = parseAssistantOutput(upstream.finalText, tools);
    if (!parsed.toolCalls.length) {
      return {
        id: `chatcmpl_${randomId(24)}`,
        created: Math.floor(Date.now() / 1000),
        model: body.model || config.defaultModel,
        message: { role: "assistant", content: parsed.content },
        usage: upstream.usage || estimateUsage(prompt, parsed.content),
      };
    }

    const assistantMessage = {
      role: "assistant",
      content: parsed.content || null,
      tool_calls: parsed.toolCalls,
    };

    if (!autoExecuteLocalTools || !parsed.toolCalls.every((call) => isExecutableLocalTool(config, call.function?.name))) {
      return {
        id: `chatcmpl_${randomId(24)}`,
        created: Math.floor(Date.now() / 1000),
        model: body.model || config.defaultModel,
        message: assistantMessage,
        usage: upstream.usage || estimateUsage(prompt, upstream.finalText),
      };
    }

    workingMessages.push(assistantMessage);
    for (const call of parsed.toolCalls) {
      const toolResult = await executeLocalToolCall(config, auth, call);
      workingMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(toolResult, null, 2),
      });
    }
  }

  return {
    id: `chatcmpl_${randomId(24)}`,
    created: Math.floor(Date.now() / 1000),
    model: body.model || config.defaultModel,
    message: { role: "assistant", content: latestText || "Tool call round limit reached." },
    usage: estimateUsage("", latestText || ""),
  };
}

async function executeLocalToolCall(config, auth, call) {
  const name = call.function.name;
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new Error(`Tool ${name} received invalid JSON arguments.`);
  }

  if (name === "get_user_info") {
    return await mimoRequest(config, auth, "GET", "/open-apis/user/mi/get");
  }
  if (name === "list_models") {
    return normalizeModelsFromConfig(await getBotConfig(config, auth));
  }
  if (name === "list_conversations") {
    return await mimoRequest(config, auth, "POST", "/open-apis/chat/conversation/list", {
      queryParam: { search: args.search || undefined },
      pageInfo: { pageNum: Number(args.pageNum || 1), pageSize: Number(args.pageSize || 20) },
    });
  }
  if (name === "list_dialogs") {
    return await mimoRequest(config, auth, "POST", "/open-apis/chat/dialog/list", {
      queryParam: { conversationId: args.conversationId, endId: args.endId },
      pageInfo: { pageNum: Number(args.pageNum || 1), pageSize: Number(args.pageSize || 10) },
    });
  }
  if (name === "exec_command") {
    if (!config.enableExecTool) {
      throw new Error("exec_command is disabled. Set ENABLE_EXEC_TOOL=true in .env to enable it.");
    }
    const command = String(args.command || "").trim();
    if (!command) {
      throw new Error("exec_command requires a command argument.");
    }
    const { stdout, stderr } = await execAsync(command, {
      cwd: path.resolve(ROOT, config.execToolCwd),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      shell: true,
    });
    return { command, stdout, stderr };
  }

  throw new Error(`Unsupported local tool: ${name}`);
}

async function requestMimoChat(config, auth, { model, prompt, multiMedias, enableThinking, webSearchMode, conversationId }) {
  const payload = {
    msgId: randomId(32),
    conversationId: conversationId || randomId(32),
    query: prompt,
    isEditedQuery: false,
    modelConfig: {
      enableThinking,
      webSearchStatus: webSearchMode,
      model,
    },
    multiMedias: Array.isArray(multiMedias) ? multiMedias : [],
  };

  try {
    const response = await rawMimoFetch(config, auth, "POST", "/open-apis/bot/chat", { body: payload });
    const text = await response.text();
    const events = parseSSEText(text);
    const stream = summarizeMimoSSE(events);
    if (!response.ok) {
      throw new Error(stream.error || `Upstream chat request failed: HTTP ${response.status}`);
    }
    if (stream.error) {
      throw new Error(stream.error);
    }
    recordUpstreamSuccess(config, auth);
    return {
      events,
      finalText: stream.text,
      usage: stream.usage,
    };
  } catch (error) {
    recordUpstreamFailure(config, auth, error);
    throw error;
  }
}

async function getBotConfig(config, auth) {
  return await mimoRequest(config, auth, "GET", "/open-apis/bot/config");
}

async function mimoRequest(config, auth, method, endpoint, body, queryParams) {
  try {
    const response = await rawMimoFetch(config, auth, method, endpoint, { body, queryParams });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Upstream returned non-JSON content: ${text.slice(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(json?.msg || json?.message || `HTTP ${response.status}`);
    }

    const code = json?.code;
    if (code !== undefined && code !== 0 && code !== 200) {
      throw new Error(json?.msg || `Upstream business error: code=${code}`);
    }

    recordUpstreamSuccess(config, auth);
    return json?.data ?? json;
  } catch (error) {
    recordUpstreamFailure(config, auth, error);
    throw error;
  }
}

async function rawMimoFetch(config, auth, method, endpoint, { body, queryParams } = {}) {
  const url = new URL(`${config.mimoBaseUrl}${endpoint}`);
  const q = new URLSearchParams(url.search);

  if (queryParams && typeof queryParams === "object") {
    Object.entries(queryParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") q.set(key, String(value));
    });
  }
  if (method.toUpperCase() === "POST" && auth?.phValue && !q.has("xiaomichatbot_ph")) {
    q.set("xiaomichatbot_ph", auth.phValue);
  }
  url.search = q.toString();

  const headers = {
    Accept: config.upstreamAccept,
    "Accept-Language": config.acceptLanguage,
    Origin: config.mimoOrigin,
    Referer: config.mimoReferer,
    "User-Agent": config.userAgent,
    "x-timeZone": config.timezone,
  };
  if (auth?.cookie) headers.Cookie = auth.cookie;
  if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";

  return await fetch(url, {
    method,
    headers,
    body: body !== undefined && body !== null ? JSON.stringify(cleanUndefined(body)) : undefined,
  });
}

function getEnabledLocalTools(config) {
  return LOCAL_TOOLS.filter((item) => item.function.name !== "exec_command" || config.enableExecTool);
}

function isExecutableLocalTool(config, name) {
  return getEnabledLocalTools(config).some((item) => item.function.name === name);
}

function applyToolChoice(tools, toolChoice) {
  if (toolChoice === "none") return [];
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return tools;

  const toolName = toolChoice?.function?.name;
  if (!toolName) return tools;
  return tools.filter((tool) => tool.function?.name === toolName);
}

export function normalizeModelsFromConfig(botConfig) {
  const list = Array.isArray(botConfig?.modelConfigListNg) && botConfig.modelConfigListNg.length
    ? botConfig.modelConfigListNg
    : botConfig?.modelConfigList || [];
  return list.map((item) => ({
    id: item.model,
    name: item.name,
    default: Boolean(item.isDefault),
    intro: item.intro?.zh || item.intro?.en || item.cnIntro || item.enIntro || "",
    isOmni: Boolean(item.isOmni),
    maxTokens: item.generation?.maxTokens || null,
    temperature: item.generation?.temperature ?? item.temperature,
    topP: item.generation?.topP ?? item.topP,
    features: item.features || {
      thinking: item.thinkingDefaultOn ? 1 : 0,
      webSearch: item.webSearchDefaultStatus === "disabled" ? 0 : 1,
      scene: {
        enabled: Array.isArray(item.enabledSceneTypeList) && item.enabledSceneTypeList.length > 0,
        types: item.enabledSceneTypeList || [],
      },
    },
  }));
}

function buildPromptFromMessages(messages, tools) {
  const lines = [];
  if (tools.length) {
    lines.push("[TOOLS_AVAILABLE]");
    lines.push(TOOL_SYSTEM_PROMPT);
    lines.push(JSON.stringify(tools, null, 2));
    lines.push("[/TOOLS_AVAILABLE]\n");
  }

  messages.forEach((message, index) => {
    const role = message.role || "user";
    const content = normalizeMessageContent(message.content);
    lines.push(`[#${index + 1} ${role.toUpperCase()}]`);
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      lines.push("assistant_tool_calls:");
      lines.push(JSON.stringify(message.tool_calls, null, 2));
    }
    if (role === "tool") {
      lines.push(`tool_name: ${message.name || "unknown"}`);
      lines.push(`tool_call_id: ${message.tool_call_id || ""}`);
    }
    lines.push(content || "");
    lines.push("");
  });

  lines.push("Answer the latest user request using the full context above. If tools are needed, output only valid <tool_call> JSON blocks exactly as instructed.");
  return lines.join("\n");
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" || item?.type === "input_text" || item?.type === "output_text") return item.text || "";
        if (item?.type === "image_url") return `[image_url] ${item.image_url?.url || ""}`;
        if (item?.type === "input_image") return `[input_image] ${item.image_url || item.file_url || ""}`;
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content, null, 2);
  return "";
}

function getLatestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role === "user") {
      return {
        ...item,
        multiMedias: collectMultiMediasFromContent(item.content),
      };
    }
  }
  return { multiMedias: [] };
}

function collectMultiMediasFromContent(content) {
  if (!Array.isArray(content)) return [];
  const medias = [];
  for (const item of content) {
    if (item?.type === "image_url") {
      medias.push({ mediaType: "image", fileUrl: item.image_url?.url, name: "remote-image", size: 0, uploadProgress: 100, status: "completed" });
    }
    if (item?.type === "input_image") {
      const url = item.image_url || item.file_url;
      medias.push({ mediaType: "image", fileUrl: url, name: "input-image", size: 0, uploadProgress: 100, status: "completed" });
    }
    if (item?.type === "mimo_file" && item.fileUrl) {
      medias.push({
        mediaType: item.mediaType || "file",
        fileUrl: item.fileUrl,
        name: item.name || "file",
        size: Number(item.size || 0),
        uploadProgress: 100,
        status: "completed",
      });
    }
  }
  return medias;
}

function parseAssistantOutput(text, tools) {
  const source = stripThinkTags(String(text || "")).trim();
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const toolCalls = [];
  let match;
  while ((match = regex.exec(source))) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const toolName = parsed.name || parsed.function?.name;
      const args = parsed.arguments || parsed.function?.arguments || {};
      if (!toolName) continue;
      const known = !tools.length || tools.some((tool) => tool.function?.name === toolName);
      if (!known) continue;
      toolCalls.push({
        id: parsed.id || `call_${randomId(12)}`,
        type: "function",
        function: {
          name: toolName,
          arguments: typeof args === "string" ? args : JSON.stringify(args),
        },
      });
    } catch {
      // Ignore invalid tool call blocks.
    }
  }
  const content = source.replace(regex, "").trim();
  return { content, toolCalls };
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((item) => item && item.type === "function" && item.function?.name)
    .map((item) => ({
      type: "function",
      function: {
        name: item.function.name,
        description: item.function.description || "",
        parameters: item.function.parameters || { type: "object", properties: {} },
      },
    }));
}

function responsesInputToMessages(input) {
  if (typeof input === "string") {
    return input.trim() ? [{ role: "user", content: input }] : [];
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => ({ role: item.role || "user", content: item.content || item.text || "" }))
      .filter((item) => normalizeMessageContent(item.content).trim());
  }
  if (input && typeof input === "object") {
    const message = { role: input.role || "user", content: input.content || input.text || "" };
    return normalizeMessageContent(message.content).trim() ? [message] : [];
  }
  return [];
}

function toChatCompletionResponse(result, model) {
  return {
    id: result.id,
    object: "chat.completion",
    created: result.created,
    model,
    choices: [{
      index: 0,
      message: result.message,
      finish_reason: result.message.tool_calls?.length ? "tool_calls" : "stop",
    }],
    usage: result.usage,
  };
}

function estimateUsage(prompt, completion) {
  const promptTokens = roughTokenCount(prompt);
  const completionTokens = roughTokenCount(completion);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function roughTokenCount(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

export function parseSSEText(text) {
  return String(text || "")
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block.split(/\n/).find((line) => line.startsWith("event:"))?.replace(/^event:\s*/, "") || "message";
      const data = block
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s*/, ""))
        .join("\n");
      return { event, raw: data };
    })
    .filter((item) => item.raw)
    .map((item) => {
      try {
        return { ...item, data: JSON.parse(item.raw) };
      } catch {
        return { ...item, data: item.raw };
      }
    });
}

function splitForStreaming(text) {
  const clean = String(text || "");
  if (!clean) return [""];
  const result = [];
  const size = 48;
  for (let i = 0; i < clean.length; i += size) {
    result.push(clean.slice(i, i + size));
  }
  return result;
}

export function summarizeMimoSSE(events) {
  const text = [];
  let usage = null;
  let error = "";

  for (const event of events || []) {
    if (event.event === "message" && event.data?.type === "text") {
      text.push(String(event.data.content || ""));
    }
    if (event.event === "usage" && event.data && typeof event.data === "object") {
      usage = {
        prompt_tokens: Number(event.data.promptTokens || 0),
        completion_tokens: Number(event.data.completionTokens || 0),
        total_tokens: Number(event.data.totalTokens || 0),
      };
    }
    if (event.event === "error") {
      error = event.data?.message || event.data?.msg || event.raw || error;
    }
  }

  return {
    text: text.join(""),
    usage,
    error: String(error || "").trim(),
  };
}

function stripThinkTags(text) {
  return String(text || "").replace(/<think>\0?[\s\S]*?<\/think>\0?/g, "").trim();
}

function resolveEnableThinking(body, config) {
  if (body.reasoning?.effort) return true;
  if (typeof body.enable_thinking === "boolean") return body.enable_thinking;
  return config.defaultEnableThinking;
}

function resolveWebSearchMode(body, config) {
  if (body.metadata?.web_search_mode) return body.metadata.web_search_mode;
  return config.defaultWebSearchMode;
}

function inferMediaType(fileName = "", mimeType = "") {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/.test(lowerName)) return "image";
  if (lowerMime.startsWith("video/") || /\.(mp4|mov|avi|webm|mkv)$/.test(lowerName)) return "video";
  if (lowerMime.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/.test(lowerName)) return "audio";
  return "file";
}

function cleanUndefined(value) {
  if (Array.isArray(value)) return value.map(cleanUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, cleanUndefined(v)]),
    );
  }
  return value;
}

function extractBearerToken(headerValue) {
  const value = String(headerValue || "").trim();
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function randomId(length = 16) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function resolvePreferredModelId(models, preferredId) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) {
    return preferredId;
  }
  if (preferredId && list.some((item) => item.id === preferredId)) {
    return preferredId;
  }
  return list.find((item) => item.default)?.id || list[0].id;
}

function recordUpstreamSuccess(config, auth) {
  const state = config.runtimeState;
  if (!state || !auth?.accountId) return;
  recordAccountSuccess(state, auth.accountId);
}

function recordUpstreamFailure(config, auth, error) {
  const state = config.runtimeState;
  if (!state || !auth?.accountId) return;
  recordAccountFailure(state, auth.accountId, formatError(error));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildAccountInputPreview(input) {
  const parsed = parseCredentialInput(input);
  return {
    source: parsed.source,
    hasCookie: Boolean(parsed.cookie),
    hasPhValue: Boolean(parsed.phValue),
    normalizedCookie: parsed.cookie,
    cookieLength: parsed.cookie.length,
    phValue: parsed.phValue,
    userId: extractCookieValue(parsed.cookie, "userId") || "",
    url: parsed.url || "",
    headers: {
      accept: parsed.headers.accept || "",
      acceptLanguage: parsed.headers["accept-language"] || "",
      origin: parsed.headers.origin || "",
      referer: parsed.headers.referer || "",
      userAgent: parsed.headers["user-agent"] || "",
      timezone: parsed.headers["x-timezone"] || "",
    },
  };
}

function sendOpenAIError(res, error, status = 500, type = "server_error") {
  res.status(status).json({ error: { message: formatError(error), type } });
}

function loadEnv(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const index = trimmed.indexOf("=");
      if (index === -1) return;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    });
  } catch {
    // Ignore missing .env file.
  }
}
