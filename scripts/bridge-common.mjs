import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const bindingVersion = 1;
export const pendingVersion = 1;
export const defaultExternalPairingTtlMs = 10 * 60 * 1000;
export const supportedShells = new Set(["powershell", "pwsh", "cmd"]);

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const conversationIdPattern = /^[a-z0-9._-]{4,128}$/i;
export const targetNamePattern = /^[a-z0-9._-]{1,64}$/i;

export const stateRoot =
  process.env.ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT ||
  join(
    process.env.LOCALAPPDATA || tmpdir(),
    "AntigravityExternalTerminalBridge",
  );
export const bindingsDir = join(stateRoot, "bindings");
export const pendingDir = join(stateRoot, "pending");
const identityKeyPath = join(stateRoot, "identity.key");

let cachedDesktopDir = null;

export function resolveDesktopDir() {
  if (cachedDesktopDir) return cachedDesktopDir;
  if (process.platform === "win32") {
    try {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-Command",
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 4000,
        },
      ).trim();
      if (output) {
        cachedDesktopDir = output;
        return cachedDesktopDir;
      }
    } catch {
      // Fall back to standard home Desktop path.
    }
  }
  cachedDesktopDir = join(homedir(), "Desktop");
  return cachedDesktopDir;
}

export function defaultPairingFilePath() {
  if (process.env.ANTIGRAVITY_TERMINAL_BRIDGE_PAIRING_FILE) {
    return process.env.ANTIGRAVITY_TERMINAL_BRIDGE_PAIRING_FILE;
  }
  return join(resolveDesktopDir(), "pairing-code.json");
}

export function normalizeConversationId(value) {
  if (typeof value !== "string") {
    throw new Error("conversationId must be a non-empty string");
  }
  const normalized = value.trim().toLowerCase();
  if (!conversationIdPattern.test(normalized) || normalized.includes("..")) {
    throw new Error(
      "invalid conversationId; expected UUID or 4-128 characters from [a-z0-9._-]",
    );
  }
  return normalized;
}

export function normalizeTargetName(value = "default") {
  if (value === undefined || value === null || value === "") {
    return "default";
  }
  if (typeof value !== "string") {
    throw new Error("targetName must be a string");
  }
  const normalized = value.trim().toLowerCase();
  if (!targetNamePattern.test(normalized) || normalized.includes("..")) {
    throw new Error(
      "invalid targetName; expected 1-64 characters from [a-z0-9._-]",
    );
  }
  return normalized;
}

export function makeOwnerKey(conversationId, targetName = "default") {
  const conv = normalizeConversationId(conversationId);
  const target = normalizeTargetName(targetName);
  return `${conv}__${target}`;
}

export function bindingPath(ownerKey) {
  if (typeof ownerKey !== "string" || !/^[a-z0-9._-]+__[a-z0-9._-]+$/.test(ownerKey)) {
    throw new Error("invalid terminal bridge owner key");
  }
  return join(bindingsDir, `${ownerKey}.json`);
}

export function pendingPath(sessionId) {
  if (typeof sessionId !== "string" || !uuidPattern.test(sessionId)) {
    throw new Error("invalid bridge session ID");
  }
  return join(pendingDir, `${sessionId.toLowerCase()}.json`);
}

function decodeIdentityKey(text) {
  const key = Buffer.from(text.trim(), "base64url");
  if (key.length !== 32) {
    throw new Error("invalid terminal bridge identity key");
  }
  return key;
}

export async function getOrCreateIdentityKey() {
  await mkdir(stateRoot, { recursive: true });
  try {
    return decodeIdentityKey(await readFile(identityKeyPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const encoded = randomBytes(32).toString("base64url");
  try {
    const handle = await open(identityKeyPath, "wx", 0o600);
    try {
      await handle.writeFile(`${encoded}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return decodeIdentityKey(encoded);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return decodeIdentityKey(await readFile(identityKeyPath, "utf8"));
  }
}

function hmac(key, fields) {
  return createHmac("sha256", key)
    .update(fields.join(":"), "utf8")
    .digest("base64url");
}

export function connectionIdentity(record) {
  if (
    record?.transport === "tcp" &&
    record?.host === "127.0.0.1" &&
    Number.isInteger(record?.port) &&
    record.port > 0 &&
    record.port <= 65535
  ) {
    return `tcp:${record.host}:${record.port}`;
  }
  throw new Error("invalid external terminal bridge TCP connection");
}

export function connectionTarget(record) {
  connectionIdentity(record);
  return { host: record.host, port: record.port };
}

export function authenticationProof(key, descriptor) {
  return hmac(key, [
    `ag-ext-bridge-v${bindingVersion}`,
    descriptor.ownerKey,
    descriptor.sessionId,
    connectionIdentity(descriptor),
  ]);
}

export function generateExternalPairingCode() {
  return randomBytes(12)
    .toString("hex")
    .toUpperCase()
    .match(/.{1,4}/g)
    .join("-");
}

export function normalizeExternalPairingCode(value) {
  if (typeof value !== "string") {
    throw new Error("external terminal pairing code must be a string");
  }
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(normalized)) {
    throw new Error(
      "invalid external terminal pairing code; expected six groups of four hexadecimal characters",
    );
  }
  return normalized;
}

export function externalPairingCodeHash(key, pairingCode) {
  return hmac(key, [
    "ag-ext-pairing-code-v1",
    normalizeExternalPairingCode(pairingCode),
  ]);
}

export function externalPairingProof(key, pending, ownerKey, pairingCode) {
  return hmac(key, [
    "ag-ext-pairing-proof-v1",
    pending.sessionId,
    connectionIdentity(pending),
    ownerKey,
    normalizeExternalPairingCode(pairingCode),
  ]);
}

export function proofsMatch(expected, received) {
  if (typeof expected !== "string" || typeof received !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function atomicWrite(directory, target, value) {
  await mkdir(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    try {
      await rename(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await rm(target, { force: true });
      await rename(temporary, target);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function validTcpConnection(value) {
  return (
    value?.transport === "tcp" &&
    value?.host === "127.0.0.1" &&
    Number.isInteger(value?.port) &&
    value.port > 0 &&
    value.port <= 65535
  );
}

export function validateBindingDescriptor(value, expectedOwnerKey = null) {
  if (
    !value ||
    value.version !== bindingVersion ||
    typeof value.ownerKey !== "string" ||
    (expectedOwnerKey && value.ownerKey !== expectedOwnerKey) ||
    typeof value.conversationId !== "string" ||
    typeof value.targetName !== "string" ||
    typeof value.sessionId !== "string" ||
    !uuidPattern.test(value.sessionId) ||
    !validTcpConnection(value) ||
    typeof value.elevated !== "boolean" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.cwd !== "string" ||
    typeof value.startedAt !== "string"
  ) {
    throw new Error("invalid external terminal bridge binding descriptor");
  }
  return value;
}

export function validatePending(value) {
  if (
    !value ||
    value.version !== pendingVersion ||
    typeof value.sessionId !== "string" ||
    !uuidPattern.test(value.sessionId) ||
    !validTcpConnection(value) ||
    typeof value.elevated !== "boolean" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.cwd !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.pairingCodeHash !== "string" ||
    value.pairingCodeHash.length < 40 ||
    typeof value.pairingExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.pairingExpiresAt))
  ) {
    throw new Error("invalid pending external terminal bridge descriptor");
  }
  return value;
}

export async function readBindingDescriptor(ownerKey) {
  const value = JSON.parse(await readFile(bindingPath(ownerKey), "utf8"));
  return validateBindingDescriptor(value, ownerKey);
}

export async function writeBindingDescriptor(descriptor) {
  validateBindingDescriptor(descriptor, descriptor.ownerKey);
  await atomicWrite(bindingsDir, bindingPath(descriptor.ownerKey), descriptor);
}

export async function removeOwnBindingDescriptor(ownerKey, sessionId) {
  try {
    const descriptor = await readBindingDescriptor(ownerKey);
    if (descriptor.sessionId === sessionId) {
      await rm(bindingPath(ownerKey), { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

export async function readPending(sessionId) {
  return validatePending(
    JSON.parse(await readFile(pendingPath(sessionId), "utf8")),
  );
}

export async function writePending(pending) {
  validatePending(pending);
  await atomicWrite(pendingDir, pendingPath(pending.sessionId), pending);
}

export async function removeOwnPending(sessionId) {
  try {
    const pending = await readPending(sessionId);
    if (pending.pid === process.pid) {
      await rm(pendingPath(sessionId), { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

async function readJsonDirectory(directory, validator) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const values = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      values.push(validator(JSON.parse(await readFile(join(directory, name), "utf8"))));
    } catch {
      // Ignore stale, partial, or incompatible entries.
    }
  }
  return values;
}

export async function listPending() {
  return readJsonDirectory(pendingDir, validatePending);
}

export async function listBindingsForConversation(conversationId) {
  const normalized = normalizeConversationId(conversationId);
  const all = await readJsonDirectory(bindingsDir, (entry) =>
    validateBindingDescriptor(entry),
  );
  return all.filter((entry) => entry.conversationId === normalized);
}

export function normalizeCwd(cwd) {
  const normalized = resolve(cwd).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function sendBridgeJson(record, payload, timeoutMs = 5000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(connectionTarget(record));
    let response = "";
    let connected = false;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectPromise(err);
      else resolvePromise(value);
    };

    const timer = setTimeout(() => {
      socket.destroy();
      const error = new Error(
        `external terminal bridge timed out after ${timeoutMs} ms`,
      );
      error.retryable = !connected;
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", (error) => {
      error.retryable = !connected;
      finish(error);
    });
    socket.on("end", () => {
      try {
        const envelope = JSON.parse(response.trim());
        finish(null, envelope);
      } catch (error) {
        error.retryable = false;
        finish(error);
      }
    });
  });
}
