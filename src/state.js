import crypto from "node:crypto";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export function createRuntimeState(config) {
  const accountsStore = loadJson(config.accountStoreFile, {
    routingStrategy: config.accountRoutingStrategy,
    activeAccountId: null,
    cursor: 0,
    accounts: [],
  });
  const keysStore = loadJson(config.keyStoreFile, {
    keys: [],
  });

  const state = {
    accountsPath: config.accountStoreFile,
    keysPath: config.keyStoreFile,
    accountsStore: normalizeAccountsStore(accountsStore, config),
    keysStore: normalizeKeysStore(keysStore),
  };

  saveAccountsStore(state);
  saveKeysStore(state);
  return state;
}

export function hasUpstreamCredentials(config, state) {
  return Boolean(config.cookie || getEnabledAccounts(state).length);
}

export function getAccountsView(state, config) {
  const now = Date.now();
  return {
    routingStrategy: state.accountsStore.routingStrategy || config.accountRoutingStrategy,
    activeAccountId: state.accountsStore.activeAccountId || null,
    envFallbackAvailable: Boolean(config.cookie),
    total: state.accountsStore.accounts.length,
    enabled: getEnabledAccounts(state).length,
    available: getAvailableAccounts(state, config, now).length,
    accounts: state.accountsStore.accounts.map((account) => toPublicAccount(account, config, now)),
  };
}

export function createAccount(state, input = {}) {
  const cookie = String(input.cookie || "").trim();
  if (!cookie) {
    throw new Error("cookie must not be empty");
  }

  const account = {
    id: `acct_${randomId(12)}`,
    name: String(input.name || "").trim() || `Account ${state.accountsStore.accounts.length + 1}`,
    cookie,
    phValue: String(input.phValue || "").trim() || extractCookieValue(cookie, "xiaomichatbot_ph") || "",
    enabled: input.enabled !== false,
    notes: String(input.notes || "").trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: "",
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
  };

  state.accountsStore.accounts.push(account);
  if (!state.accountsStore.activeAccountId) {
    state.accountsStore.activeAccountId = account.id;
  }
  saveAccountsStore(state);
  return toPublicAccount(account);
}

export function patchAccount(state, accountId, input = {}) {
  const account = state.accountsStore.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("account not found");
  }

  if (input.name !== undefined) {
    account.name = String(input.name || "").trim() || account.name;
  }
  if (input.cookie !== undefined) {
    const cookie = String(input.cookie || "").trim();
    if (!cookie) {
      throw new Error("cookie must not be empty");
    }
    account.cookie = cookie;
    if (input.phValue === undefined) {
      account.phValue = extractCookieValue(cookie, "xiaomichatbot_ph") || account.phValue || "";
    }
  }
  if (input.phValue !== undefined) {
    account.phValue = String(input.phValue || "").trim();
  }
  if (input.enabled !== undefined) {
    account.enabled = Boolean(input.enabled);
  }
  if (input.notes !== undefined) {
    account.notes = String(input.notes || "").trim();
  }

  account.updatedAt = new Date().toISOString();
  saveAccountsStore(state);
  return toPublicAccount(account);
}

export function deleteAccount(state, accountId) {
  const before = state.accountsStore.accounts.length;
  state.accountsStore.accounts = state.accountsStore.accounts.filter((item) => item.id !== accountId);
  if (state.accountsStore.accounts.length === before) {
    throw new Error("account not found");
  }

  if (state.accountsStore.activeAccountId === accountId) {
    state.accountsStore.activeAccountId = state.accountsStore.accounts[0]?.id || null;
  }

  state.accountsStore.cursor = 0;
  saveAccountsStore(state);
}

export function setRoutingStrategy(state, strategy) {
  const next = String(strategy || "").trim();
  if (!["round_robin", "single"].includes(next)) {
    throw new Error("routingStrategy must be round_robin or single");
  }

  state.accountsStore.routingStrategy = next;
  saveAccountsStore(state);
  return next;
}

export function setActiveAccount(state, accountId) {
  if (accountId !== null && !state.accountsStore.accounts.some((item) => item.id === accountId)) {
    throw new Error("account not found");
  }

  state.accountsStore.activeAccountId = accountId;
  saveAccountsStore(state);
  return accountId;
}

export function pickUpstreamAccount(state, config) {
  const now = Date.now();
  const enabled = getEnabledAccounts(state);
  if (!enabled.length) {
    if (!config.cookie) {
      throw new Error("No MiMo account configured. Add an account with a cookie or set MIMO_COOKIE in .env.");
    }

    return {
      source: "env",
      accountId: null,
      name: "Environment Account",
      cookie: config.cookie,
      phValue: config.phValue,
    };
  }

  const available = getAvailableAccounts(state, config, now);
  const pool = available.length ? available : enabled;
  let selected = enabled[0];
  if (state.accountsStore.routingStrategy === "single") {
    selected = pool.find((item) => item.id === state.accountsStore.activeAccountId) || pool[0];
  } else {
    const cursor = Number(state.accountsStore.cursor || 0);
    selected = pool[cursor % pool.length];
    state.accountsStore.cursor = (cursor + 1) % pool.length;
  }

  selected.lastUsedAt = new Date().toISOString();
  saveAccountsStore(state);

  return {
    source: "pool",
    accountId: selected.id,
    name: selected.name,
    cookie: selected.cookie,
    phValue: selected.phValue,
  };
}

export function recordAccountSuccess(state, accountId) {
  const account = state.accountsStore.accounts.find((item) => item.id === accountId);
  if (!account) return;

  const now = new Date().toISOString();
  account.lastCheckedAt = now;
  account.lastSuccessAt = now;
  account.lastError = "";
  account.successCount = Number(account.successCount || 0) + 1;
  account.consecutiveFailures = 0;
  account.updatedAt = now;
  saveAccountsStore(state);
}

export function recordAccountFailure(state, accountId, error) {
  const account = state.accountsStore.accounts.find((item) => item.id === accountId);
  if (!account) return;

  const now = new Date().toISOString();
  account.lastCheckedAt = now;
  account.lastFailureAt = now;
  account.lastError = String(error || "Unknown upstream error");
  account.failureCount = Number(account.failureCount || 0) + 1;
  account.consecutiveFailures = Number(account.consecutiveFailures || 0) + 1;
  account.updatedAt = now;
  saveAccountsStore(state);
}

export function exportRuntimeState(state) {
  return {
    exportedAt: new Date().toISOString(),
    accounts: state.accountsStore,
    keys: state.keysStore,
  };
}

export function importRuntimeState(state, snapshot = {}, mode = "replace") {
  const nextAccounts = normalizeAccountsStore(snapshot.accounts || {}, {
    accountRoutingStrategy: snapshot.accounts?.routingStrategy || "round_robin",
  });
  const nextKeys = normalizeKeysStore(snapshot.keys || {});

  if (mode === "merge") {
    const accountMap = new Map(state.accountsStore.accounts.map((item) => [item.id, item]));
    nextAccounts.accounts.forEach((item) => accountMap.set(item.id, item));
    state.accountsStore = {
      routingStrategy: nextAccounts.routingStrategy || state.accountsStore.routingStrategy,
      activeAccountId: nextAccounts.activeAccountId || state.accountsStore.activeAccountId,
      cursor: 0,
      accounts: [...accountMap.values()],
    };

    const keyMap = new Map(state.keysStore.keys.map((item) => [item.id, item]));
    nextKeys.keys.forEach((item) => keyMap.set(item.id, item));
    state.keysStore = {
      keys: [...keyMap.values()],
    };
  } else {
    state.accountsStore = nextAccounts;
    state.keysStore = nextKeys;
  }

  saveAccountsStore(state);
  saveKeysStore(state);
}

export function getKeysView(state) {
  const enabled = state.keysStore.keys.filter((item) => item.enabled).length;
  return {
    total: state.keysStore.keys.length,
    enabled,
    authenticationRequired: enabled > 0,
    keys: state.keysStore.keys.map(toPublicKey),
  };
}

export function hasEnabledApiKeys(state) {
  return state.keysStore.keys.some((item) => item.enabled);
}

export function createApiKey(state, input = {}) {
  const plainKey = String(input.key || "").trim() || `mimo_${randomId(32)}`;
  const hash = hashApiKey(plainKey);

  if (state.keysStore.keys.some((item) => item.hash === hash)) {
    throw new Error("API key already exists");
  }

  const record = {
    id: `key_${randomId(12)}`,
    name: String(input.name || "").trim() || `Key ${state.keysStore.keys.length + 1}`,
    hash,
    prefix: plainKey.slice(0, 8),
    suffix: plainKey.slice(-4),
    enabled: input.enabled !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  state.keysStore.keys.push(record);
  saveKeysStore(state);

  return {
    key: plainKey,
    record: toPublicKey(record),
  };
}

export function patchApiKey(state, keyId, input = {}) {
  const record = state.keysStore.keys.find((item) => item.id === keyId);
  if (!record) {
    throw new Error("API key not found");
  }

  if (input.name !== undefined) {
    record.name = String(input.name || "").trim() || record.name;
  }
  if (input.enabled !== undefined) {
    record.enabled = Boolean(input.enabled);
  }
  record.updatedAt = new Date().toISOString();

  saveKeysStore(state);
  return toPublicKey(record);
}

export function deleteApiKey(state, keyId) {
  const before = state.keysStore.keys.length;
  state.keysStore.keys = state.keysStore.keys.filter((item) => item.id !== keyId);
  if (state.keysStore.keys.length === before) {
    throw new Error("API key not found");
  }
  saveKeysStore(state);
}

export function authenticateApiKey(state, presentedKey) {
  const plain = String(presentedKey || "").trim();
  if (!plain) {
    return null;
  }

  const hash = hashApiKey(plain);
  const record = state.keysStore.keys.find((item) => item.hash === hash && item.enabled);
  if (!record) {
    return null;
  }

  record.lastUsedAt = new Date().toISOString();
  saveKeysStore(state);
  return toPublicKey(record);
}

export function extractCookieValue(cookieText, name) {
  const parts = String(cookieText || "").split(/;\s*/);
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === name) return value;
  }
  return "";
}

function getEnabledAccounts(state) {
  return state.accountsStore.accounts.filter((item) => item.enabled && item.cookie);
}

function getAvailableAccounts(state, config, now = Date.now()) {
  return getEnabledAccounts(state).filter((account) => {
    const retryAt = getRetryAt(account, config);
    return !retryAt || retryAt <= now;
  });
}

function toPublicAccount(account, config = {}, now = Date.now()) {
  const retryAt = getRetryAt(account, config);
  const coolingDown = Boolean(retryAt && retryAt > now);
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    status: !account.enabled ? "disabled" : coolingDown ? "cooldown" : account.consecutiveFailures > 0 ? "degraded" : "healthy",
    phValue: account.phValue ? maskValue(account.phValue, 4, 4) : "",
    cookiePreview: maskValue(account.cookie, 18, 8),
    notes: account.notes || "",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastUsedAt: account.lastUsedAt,
    lastCheckedAt: account.lastCheckedAt,
    lastSuccessAt: account.lastSuccessAt,
    lastFailureAt: account.lastFailureAt,
    lastError: account.lastError || "",
    successCount: Number(account.successCount || 0),
    failureCount: Number(account.failureCount || 0),
    consecutiveFailures: Number(account.consecutiveFailures || 0),
    retryAt: retryAt ? new Date(retryAt).toISOString() : null,
  };
}

function toPublicKey(record) {
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    preview: `${record.prefix}...${record.suffix}`,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function loadJson(filePath, fallback) {
  try {
    const content = readFileSync(filePath, "utf8");
    return content.trim() ? JSON.parse(content) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeAccountsStore(value, config) {
  return {
    routingStrategy: ["round_robin", "single"].includes(value?.routingStrategy) ? value.routingStrategy : config.accountRoutingStrategy,
    activeAccountId: typeof value?.activeAccountId === "string" ? value.activeAccountId : null,
    cursor: Number.isInteger(value?.cursor) ? value.cursor : 0,
    accounts: Array.isArray(value?.accounts) ? value.accounts.map((item) => ({
      id: item.id || `acct_${randomId(12)}`,
      name: item.name || "Unnamed Account",
      cookie: item.cookie || "",
      phValue: item.phValue || extractCookieValue(item.cookie || "", "xiaomichatbot_ph") || "",
      enabled: item.enabled !== false,
      notes: item.notes || "",
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      lastUsedAt: item.lastUsedAt || null,
      lastCheckedAt: item.lastCheckedAt || null,
      lastSuccessAt: item.lastSuccessAt || null,
      lastFailureAt: item.lastFailureAt || null,
      lastError: item.lastError || "",
      successCount: Number(item.successCount || 0),
      failureCount: Number(item.failureCount || 0),
      consecutiveFailures: Number(item.consecutiveFailures || 0),
    })) : [],
  };
}

function getRetryAt(account, config = {}) {
  const failures = Number(account.consecutiveFailures || 0);
  if (failures < Number(config.accountFailureThreshold || 3)) {
    return null;
  }

  const lastFailureAt = account.lastFailureAt ? Date.parse(account.lastFailureAt) : 0;
  if (!lastFailureAt) {
    return null;
  }

  return lastFailureAt + Number(config.accountCooldownMs || 300000);
}

function normalizeKeysStore(value) {
  return {
    keys: Array.isArray(value?.keys) ? value.keys.map((item) => ({
      id: item.id || `key_${randomId(12)}`,
      name: item.name || "Unnamed Key",
      hash: item.hash || "",
      prefix: item.prefix || "",
      suffix: item.suffix || "",
      enabled: item.enabled !== false,
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      lastUsedAt: item.lastUsedAt || null,
    })).filter((item) => item.hash) : [],
  };
}

function saveAccountsStore(state) {
  saveJson(state.accountsPath, state.accountsStore);
}

function saveKeysStore(state) {
  saveJson(state.keysPath, state.keysStore);
}

function saveJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

function maskValue(value, start = 8, end = 4) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= start + end) {
    return `${text.slice(0, Math.min(4, text.length))}...`;
  }
  return `${text.slice(0, start)}...${text.slice(-end)}`;
}

function randomId(length = 16) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}
