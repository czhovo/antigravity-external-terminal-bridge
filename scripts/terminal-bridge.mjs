import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authenticationProof,
  bindingVersion,
  defaultExternalPairingTtlMs,
  externalPairingCodeHash,
  externalPairingProof,
  generateExternalPairingCode,
  getOrCreateIdentityKey,
  pendingVersion,
  proofsMatch,
  removeOwnBindingDescriptor,
  removeOwnPending,
  stateRoot,
  supportedShells,
  writeBindingDescriptor,
  writePending,
} from "./bridge-common.mjs";
import { createConPtyOutputProcessor } from "./conpty-processor.mjs";
import { createAdaptiveStreamDecoder } from "./stream-decoder.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const conptyRunnerPath = join(scriptDir, "conpty-runner.exe");
const ptySupported = process.platform === "win32" && existsSync(conptyRunnerPath);

const args = process.argv.slice(2);
const elevated = args.includes("--elevated");
const forcePty = args.includes("--pty");
const disablePty = args.includes("--no-pty");
const defaultUsePty =
  ptySupported && (forcePty || (!disablePty && Boolean(process.stdout.isTTY)));
let pairingFilePath = null;
let terminalLabel = "";
let defaultShell = "powershell";
let pairingTtlMs = defaultExternalPairingTtlMs;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--pairing-file") {
    pairingFilePath = args[index + 1] || null;
    index += 1;
  } else if (arg.startsWith("--pairing-file=")) {
    pairingFilePath = arg.slice("--pairing-file=".length) || null;
  } else if (arg === "--label") {
    terminalLabel = (args[index + 1] || "").trim();
    index += 1;
  } else if (arg.startsWith("--label=")) {
    terminalLabel = arg.slice("--label=".length).trim();
  } else if (arg === "--shell") {
    const candidate = (args[index + 1] || "").trim().toLowerCase();
    if (!supportedShells.has(candidate)) {
      throw new Error(`unsupported shell: ${candidate}; expected powershell, pwsh, or cmd`);
    }
    defaultShell = candidate;
    index += 1;
  } else if (arg.startsWith("--shell=")) {
    const candidate = arg.slice("--shell=".length).trim().toLowerCase();
    if (!supportedShells.has(candidate)) {
      throw new Error(`unsupported shell: ${candidate}; expected powershell, pwsh, or cmd`);
    }
    defaultShell = candidate;
  } else if (arg === "--ttl-seconds") {
    const seconds = Number(args[index + 1]);
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
      throw new Error("--ttl-seconds must be between 5 and 3600");
    }
    pairingTtlMs = Math.round(seconds * 1000);
    index += 1;
  } else if (arg.startsWith("--ttl-seconds=")) {
    const seconds = Number(arg.slice("--ttl-seconds=".length));
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
      throw new Error("--ttl-seconds must be between 5 and 3600");
    }
    pairingTtlMs = Math.round(seconds * 1000);
  }
}

const sessionId = randomUUID();
const startedAt = new Date().toISOString();
const initialCwd = process.cwd();
let currentCwd = initialCwd;
const username = (() => {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || "unknown";
  }
})();
const identityKey = await getOrCreateIdentityKey();

let connection = null;
let externalPairingCode = null;
let pairingExpiresAt = null;
let pendingDescriptor = null;
let ownerKey = null;
let conversationId = null;
let targetName = null;
let descriptor = null;
let expectedProof = null;
let shuttingDown = false;
let activeBatchChild = null;
let activeBatchInfo = null;
let pairingExpiryTimer = null;
const jobs = new Map();

function writeTerminal(text) {
  process.stdout.write(text);
}

function setTerminalTitle(title) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}

function safeCommandLabel(command) {
  return command.replace(/\r?\n/g, " ⏎ ");
}

function pairingFileRecord() {
  if (!externalPairingCode || !connection) {
    throw new Error("external pairing information is not ready");
  }
  return {
    version: 1,
    mode: "external",
    product: "antigravity-external-terminal-bridge",
    pairingCode: externalPairingCode,
    createdAt: new Date().toISOString(),
    expiresAt: pairingExpiresAt,
    sessionId,
    pid: process.pid,
    cwd: currentCwd,
    elevated,
    username,
    label: terminalLabel || (elevated ? "Administrator External Terminal" : "External Terminal"),
    shell: defaultShell,
    transport: connection.transport,
    host: connection.host,
    port: connection.port,
  };
}

async function writePairingFile() {
  if (!pairingFilePath) return;
  const temporaryPath = `${pairingFilePath}.${sessionId}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(pairingFileRecord(), null, 2)}\n`,
      "utf8",
    );
    try {
      await rename(temporaryPath, pairingFilePath);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await rm(pairingFilePath, { force: true });
      await rename(temporaryPath, pairingFilePath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function removeOwnPairingFile() {
  if (!pairingFilePath) return;
  try {
    const record = JSON.parse(await readFile(pairingFilePath, "utf8"));
    if (record?.sessionId === sessionId) {
      await rm(pairingFilePath, { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // Never delete a pairing file whose ownership cannot be verified.
    }
  }
  await rm(`${pairingFilePath}.${sessionId}.tmp`, { force: true });
}

function clearPairingExpiryTimer() {
  if (pairingExpiryTimer) {
    clearTimeout(pairingExpiryTimer);
    pairingExpiryTimer = null;
  }
}

function schedulePairingExpiry() {
  clearPairingExpiryTimer();
  const delayMs = Math.max(Date.parse(pairingExpiresAt) - Date.now(), 0);
  pairingExpiryTimer = setTimeout(() => {
    void (async () => {
      if (!externalPairingCode) return;
      externalPairingCode = null;
      pendingDescriptor = null;
      await removeOwnPending(sessionId);
      await removeOwnPairingFile();
      writeTerminal(
        "\r\n[External Bridge] Pairing code expired. Restart this bridge to generate a new code.\r\n",
      );
    })();
  }, delayMs);
}

function buildPendingDescriptor() {
  if (!connection || !externalPairingCode || !pairingExpiresAt) {
    throw new Error("terminal bridge endpoint or pairing code is not ready");
  }
  return {
    version: pendingVersion,
    sessionId,
    pid: process.pid,
    ...connection,
    cwd: currentCwd,
    startedAt,
    elevated,
    username,
    label: terminalLabel || (elevated ? "Administrator External Terminal" : "External Terminal"),
    shell: defaultShell,
    pairingCodeHash: externalPairingCodeHash(identityKey, externalPairingCode),
    pairingExpiresAt,
  };
}

async function openPairingWindow() {
  externalPairingCode = generateExternalPairingCode();
  pairingExpiresAt = new Date(Date.now() + pairingTtlMs).toISOString();
  pendingDescriptor = buildPendingDescriptor();
  await writePending(pendingDescriptor);
  await writePairingFile();
  schedulePairingExpiry();
}

function authorize(request) {
  if (
    !ownerKey ||
    !descriptor ||
    !expectedProof ||
    request?.ownerKey !== ownerKey ||
    request?.sessionId !== sessionId ||
    !proofsMatch(expectedProof, request?.authProof)
  ) {
    throw new Error("terminal session authentication failed");
  }
}

async function bindToOwner(nextOwnerKey, nextConversationId, nextTargetName) {
  if (ownerKey && ownerKey !== nextOwnerKey) {
    throw new Error("external terminal is already bound to another Antigravity session");
  }
  ownerKey = nextOwnerKey;
  conversationId = nextConversationId;
  targetName = nextTargetName;
  descriptor = {
    version: bindingVersion,
    ownerKey,
    conversationId,
    targetName,
    sessionId,
    pid: process.pid,
    ...connection,
    cwd: currentCwd,
    initialCwd,
    startedAt,
    elevated,
    username,
    label: terminalLabel || (elevated ? "Administrator External Terminal" : "External Terminal"),
    shell: defaultShell,
  };
  expectedProof = authenticationProof(identityKey, descriptor);
  await writeBindingDescriptor(descriptor);
  await removeOwnPending(sessionId);
  return descriptor;
}

async function removeOwnState() {
  await removeOwnPending(sessionId);
  if (ownerKey) await removeOwnBindingDescriptor(ownerKey, sessionId);
  await removeOwnPairingFile();
}

function resolveShellExecutable(requestedShell) {
  const chosen = (requestedShell || defaultShell || "powershell").toLowerCase();
  if (!supportedShells.has(chosen)) {
    throw new Error(`unsupported shell: ${chosen}; expected powershell, pwsh, or cmd`);
  }
  if (chosen === "pwsh") return { shell: "pwsh", executable: "pwsh.exe" };
  if (chosen === "cmd") return { shell: "cmd", executable: "cmd.exe" };
  return { shell: "powershell", executable: "powershell.exe" };
}

function escapePowerShellSingleQuoted(text) {
  return text.replace(/'/g, "''");
}

function buildPowerShellBatchScript(commands, cwdOutPath) {
  const lines = [
    "try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "$global:LASTEXITCODE = 0",
    "$ErrorActionPreference = 'Continue'",
  ];

  commands.forEach((command, index) => {
    const label = safeCommandLabel(command)
      .replace(/`/g, "``")
      .replace(/"/g, '`"')
      .replace(/\$/g, "`$");
    lines.push(
      'Write-Host ""',
      `Write-Host "[antigravity-bridge ${index + 1}/${commands.length}] ${label}" -ForegroundColor Cyan`,
      "$global:LASTEXITCODE = 0",
      "& {",
      command,
      "}",
      `$__agy_bridge_code_${index} = if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } elseif ($?) { 0 } else { 1 }`,
      `Write-Host "[exit $__agy_bridge_code_${index}]" -ForegroundColor DarkGray`,
    );
  });

  if (cwdOutPath) {
    lines.push(
      "try {",
      `  [System.IO.File]::WriteAllText('${escapePowerShellSingleQuoted(cwdOutPath)}', (Get-Location).ProviderPath, [System.Text.UTF8Encoding]::new($false))`,
      "} catch {}",
    );
  }

  lines.push(
    `$__agy_bridge_codes = @(${commands
      .map((_, index) => `$__agy_bridge_code_${index}`)
      .join(", ")})`,
    "$__agy_bridge_final = ($__agy_bridge_codes | Where-Object { $_ -ne 0 } | Select-Object -Last 1)",
    "if ($null -eq $__agy_bridge_final) { $__agy_bridge_final = 0 }",
    "exit $__agy_bridge_final",
  );
  return lines.join("\r\n");
}

function buildCmdBatchScript(commands, cwdOutPath) {
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "set __AGY_FINAL_CODE=0",
  ];
  commands.forEach((command, index) => {
    const label = safeCommandLabel(command).replace(/[%^&|<>]/g, "^$&");
    lines.push(
      "echo.",
      `echo [antigravity-bridge ${index + 1}/${commands.length}] ${label}`,
      command,
      "if errorlevel 1 set __AGY_FINAL_CODE=%errorlevel%",
    );
  });
  if (cwdOutPath) {
    lines.push(`cd > "${cwdOutPath}"`);
  }
  lines.push("exit /b %__AGY_FINAL_CODE%");
  return lines.join("\r\n");
}

function createCappedBuffer(maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  let capturedBytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += buf.length;
      if (capturedBytes < maxBytes) {
        const remaining = maxBytes - capturedBytes;
        if (buf.length <= remaining) {
          chunks.push(buf);
          capturedBytes += buf.length;
        } else {
          chunks.push(buf.subarray(0, remaining));
          capturedBytes += remaining;
          truncated = true;
        }
      } else {
        truncated = true;
      }
    },
    text() {
      const base = Buffer.concat(chunks).toString("utf8");
      if (!truncated) return base;
      return `${base}\n...[truncated: captured ${capturedBytes} of ${totalBytes} bytes; full output was streamed to the external terminal]`;
    },
    truncated: () => truncated,
    totalBytes: () => totalBytes,
  };
}

function appendTail(current, chunk, maxChars = 65536) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const combined = `${current}${text}`;
  return combined.length <= maxChars
    ? combined
    : combined.slice(combined.length - maxChars);
}

function publicJob(record) {
  return {
    jobId: record.jobId,
    command: record.command,
    shell: record.shell,
    cwd: record.cwd,
    pid: record.pid,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    exitCode: record.exitCode ?? null,
    signal: record.signal ?? null,
    promotedFromBatch: Boolean(record.promotedFromBatch),
    promotionReason: record.promotionReason ?? null,
    stdoutTail: record.stdoutTail,
    stderrTail: record.stderrTail,
  };
}

function pruneCompletedJobs() {
  const completed = [...jobs.values()]
    .filter((job) => job.status !== "running")
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
  for (const record of completed.slice(50)) {
    jobs.delete(record.jobId);
  }
}

async function terminateProcessTree(pid) {
  if (!pid) return;
  await new Promise((resolvePromise) => {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.on("error", () => resolvePromise());
    killer.on("close", () => resolvePromise());
  });
}

async function startLongRunningCommand(request) {
  const command = request.command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("command must be a non-empty string");
  }
  if (command.length > 32768) {
    throw new Error("command exceeds the 32768-character limit");
  }

  const cwd = request.cwd || currentCwd;
  if (!existsSync(cwd)) {
    throw new Error(`working directory does not exist: ${cwd}`);
  }

  const { shell, executable } = resolveShellExecutable(request.shell);
  const usePty =
    typeof request.pty === "boolean"
      ? request.pty && ptySupported
      : defaultUsePty;
  const cols = Math.max(40, Math.min(process.stdout.columns || 120, 400));
  const rows = Math.max(10, Math.min(process.stdout.rows || 30, 200));
  const startupGraceMs = Math.min(
    Math.max(Number(request.startupGraceMs) || 350, 0),
    5000,
  );
  const jobId = randomUUID();
  let scriptPath;
  let spawnArgs;

  if (shell === "cmd") {
    scriptPath = join(stateRoot, `job-${sessionId}-${jobId}.cmd`);
    await writeFile(
      scriptPath,
      `@echo off\r\nchcp 65001 >nul\r\n${command}\r\n`,
      "utf8",
    );
    spawnArgs = ["/d", "/c", scriptPath];
  } else {
    scriptPath = join(stateRoot, `job-${sessionId}-${jobId}.ps1`);
    const psBody = [
      "try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
      "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
      "$OutputEncoding = [System.Text.Encoding]::UTF8",
      command,
      "",
    ].join("\r\n");
    await writeFile(scriptPath, `\uFEFF${psBody}`, "utf8");
    spawnArgs = usePty
      ? [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ]
      : [
          "-NoLogo",
          "-NoProfile",
          "-InputFormat",
          "None",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ];
  }

  const spawnExe = usePty ? conptyRunnerPath : executable;
  const finalSpawnArgs = usePty
    ? [
        "--cols",
        String(cols),
        "--rows",
        String(rows),
        "--cwd",
        cwd,
        "--forward-stdin",
        "--",
        executable,
        ...spawnArgs,
      ]
    : spawnArgs;

  const child = spawn(spawnExe, finalSpawnArgs, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let resolveClosed;
  const record = {
    jobId,
    command,
    shell,
    pty: usePty,
    cwd,
    pid: child.pid,
    child,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    stdoutTail: "",
    stderrTail: "",
    closed: new Promise((resolvePromise) => {
      resolveClosed = resolvePromise;
    }),
  };
  jobs.set(jobId, record);

  writeTerminal(
    `\r\n=== [Antigravity Job Started] ${jobId} (PID ${child.pid}, ${shell}${usePty ? ", PTY" : ""}) ===\r\n$ ${safeCommandLabel(command)}\r\n`,
  );

  const stdoutDecoder = usePty
    ? createConPtyOutputProcessor({
        cols,
        rows,
        idleFlushMs: 50,
        onTerminal: (text) => process.stdout.write(text),
        onCleanText: (text) => {
          record.stdoutTail = appendTail(record.stdoutTail, text);
        },
      })
    : createAdaptiveStreamDecoder(
        (text) => {
          record.stdoutTail = appendTail(record.stdoutTail, text);
          process.stdout.write(text);
        },
        { idleFlushMs: 80 },
      );
  const stderrDecoder = createAdaptiveStreamDecoder(
    (text) => {
      record.stderrTail = appendTail(record.stderrTail, text);
      process.stderr.write(text);
    },
    { idleFlushMs: 80 },
  );

  child.stdout.on("data", (chunk) => {
    stdoutDecoder.push(chunk);
  });
  child.stdout.on("end", () => {
    stdoutDecoder.flush();
  });
  child.stderr.on("data", (chunk) => {
    stderrDecoder.push(chunk);
  });
  child.stderr.on("end", () => {
    stderrDecoder.flush();
  });
  child.on("error", (error) => {
    record.status = "failed";
    record.stderrTail = appendTail(record.stderrTail, error.message);
  });
  child.on("close", (code, signal) => {
    stdoutDecoder.flush();
    stderrDecoder.flush();
    record.status =
      record.status === "stopping"
        ? "stopped"
        : record.status === "failed"
          ? "failed"
          : "completed";
    record.endedAt = new Date().toISOString();
    record.exitCode = code;
    record.signal = signal;
    void rm(scriptPath, { force: true });
    writeTerminal(
      `\r\n=== [Antigravity Job Exited] ${jobId} (code ${code ?? -1}) ===\r\n`,
    );
    resolveClosed();
    pruneCompletedJobs();
  });

  if (startupGraceMs > 0) {
    await Promise.race([
      record.closed,
      new Promise((resolvePromise) => setTimeout(resolvePromise, startupGraceMs)),
    ]);
  }
  return publicJob(record);
}

function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(publicJob);
}

function getJob(jobId) {
  const record = jobs.get(jobId);
  if (!record) {
    throw new Error(`terminal job not found: ${jobId}`);
  }
  return publicJob(record);
}

async function sendJobInput(jobId, input, appendNewline = true) {
  const record = jobs.get(jobId);
  if (!record) {
    throw new Error(`terminal job not found: ${jobId}`);
  }
  if (record.status !== "running" || !record.child?.stdin || record.child.stdin.destroyed) {
    throw new Error(`terminal job ${jobId} is not accepting stdin (status: ${record.status})`);
  }
  if (typeof input !== "string") {
    throw new Error("input must be a string");
  }
  const payload = appendNewline ? `${input}\r\n` : input;
  await new Promise((resolvePromise, rejectPromise) => {
    record.child.stdin.write(payload, "utf8", (err) => {
      if (err) rejectPromise(err);
      else resolvePromise();
    });
  });
  writeTerminal(`[stdin -> job ${jobId}] ${safeCommandLabel(input)}\r\n`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  return publicJob(record);
}

async function stopJob(jobId) {
  const record = jobs.get(jobId);
  if (!record) {
    throw new Error(`terminal job not found: ${jobId}`);
  }
  if (record.status !== "running") {
    return publicJob(record);
  }

  record.status = "stopping";
  await terminateProcessTree(record.pid);
  await Promise.race([
    record.closed,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
  ]);
  return publicJob(record);
}

async function persistBatchCwd(cwdOutPath) {
  if (!cwdOutPath || !existsSync(cwdOutPath)) return;
  try {
    const nextCwd = (await readFile(cwdOutPath, "utf8")).trim();
    if (nextCwd && existsSync(nextCwd)) {
      currentCwd = nextCwd;
      if (descriptor) {
        descriptor = { ...descriptor, cwd: currentCwd };
        await writeBindingDescriptor(descriptor);
      }
    }
  } catch {
    // Ignore CWD persistence read errors.
  }
}

async function runBatch(request, context = {}) {
  const commands = request.commands;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 50) {
    throw new Error("commands must contain between 1 and 50 entries");
  }
  for (const command of commands) {
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("each command must be a non-empty string");
    }
    if (command.length > 32768) {
      throw new Error("a command exceeds the 32768-character limit");
    }
  }

  const explicitCwd = typeof request.cwd === "string" && request.cwd.trim() !== ""
    ? request.cwd.trim()
    : null;
  const cwd = explicitCwd || currentCwd;
  if (!existsSync(cwd)) {
    throw new Error(`working directory does not exist: ${cwd}`);
  }

  const { shell, executable } = resolveShellExecutable(request.shell);
  const usePty =
    typeof request.pty === "boolean"
      ? request.pty && ptySupported
      : defaultUsePty;
  const cols = Math.max(40, Math.min(process.stdout.columns || 120, 400));
  const rows = Math.max(10, Math.min(process.stdout.rows || 30, 200));
  // Cap synchronous batch wait at 50s (default 45s) so it always returns cleanly before MCP ~60s timeout.
  const timeoutMs = Math.min(
    Math.max(Number(request.timeoutMs) || 45000, 1000),
    50000,
  );
  const killOnTimeout = Boolean(request.killOnTimeout);
  const maxOutputBytes = Math.min(
    Math.max(Number(request.maxOutputBytes) || 131072, 4096),
    1048576,
  );
  const persistCwd = request.persistCwd !== false && !explicitCwd;
  const batchId = randomUUID();
  const cwdOutPath = persistCwd
    ? join(stateRoot, `cwd-${sessionId}-${batchId}.txt`)
    : null;

  let scriptPath;
  let spawnArgs;
  if (shell === "cmd") {
    scriptPath = join(stateRoot, `batch-${sessionId}-${batchId}.cmd`);
    await writeFile(scriptPath, buildCmdBatchScript(commands, cwdOutPath), "utf8");
    spawnArgs = ["/d", "/c", scriptPath];
  } else {
    scriptPath = join(stateRoot, `batch-${sessionId}-${batchId}.ps1`);
    await writeFile(
      scriptPath,
      `\uFEFF${buildPowerShellBatchScript(commands, cwdOutPath)}`,
      "utf8",
    );
    spawnArgs = [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ];
  }

  const spawnExe = usePty ? conptyRunnerPath : executable;
  const finalSpawnArgs = usePty
    ? [
        "--cols",
        String(cols),
        "--rows",
        String(rows),
        "--cwd",
        cwd,
        "--",
        executable,
        ...spawnArgs,
      ]
    : spawnArgs;

  const started = Date.now();
  const batchStartedAt = new Date(started).toISOString();
  const stdoutCap = createCappedBuffer(maxOutputBytes);
  const stderrCap = createCappedBuffer(maxOutputBytes);
  let timedOut = false;
  let killed = false;
  let promotedJob = null;
  let childExited = false;
  let resolveChildClosed;
  const childClosed = new Promise((resolvePromise) => {
    resolveChildClosed = resolvePromise;
  });

  writeTerminal(
    `\r\n=== [Antigravity Batch] ${commands.length} command${commands.length === 1 ? "" : "s"} (${shell}${usePty ? ", PTY" : ""}${elevated ? ", ADMIN" : ""}) ===\r\n`,
  );

  try {
    const result = await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) rejectPromise(err);
        else resolvePromise(value);
      };

      const child = spawn(spawnExe, finalSpawnArgs, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeBatchChild = child;
      activeBatchInfo = {
        pid: child.pid,
        startedAt: batchStartedAt,
        commands: commands.map((c) => safeCommandLabel(c).slice(0, 200)),
        shell,
        cwd,
      };

      const promoteToManagedJob = (reason) => {
        if (promotedJob) return promotedJob;
        if (childExited) return null;
        const jobId = randomUUID();
        const record = {
          jobId,
          command: commands.join(" ; "),
          shell,
          pty: usePty,
          cwd,
          pid: child.pid,
          child,
          status: "running",
          startedAt: batchStartedAt,
          endedAt: null,
          exitCode: null,
          signal: null,
          promotedFromBatch: true,
          promotionReason: reason,
          stdoutTail: stdoutCap.text(),
          stderrTail: stderrCap.text(),
          closed: childClosed,
        };
        jobs.set(jobId, record);
        promotedJob = record;
        if (activeBatchChild === child) {
          activeBatchChild = null;
          activeBatchInfo = null;
        }
        writeTerminal(
          `\r\n=== [Antigravity Batch Promoted to Job] ${jobId} (PID ${child.pid}, reason: ${reason}) ===\r\n`,
        );
        return record;
      };

      if (typeof context.onClientDisconnect === "function") {
        context.onClientDisconnect(() => {
          if (!settled && !childExited && !promotedJob) {
            clearTimeout(timer);
            const job = promoteToManagedJob("client-disconnected");
            finish(null, { promoted: true, job });
          }
        });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        if (killOnTimeout) {
          killed = true;
          void terminateProcessTree(child.pid);
        } else {
          const job = promoteToManagedJob("sync-timeout");
          finish(null, { promoted: true, job });
        }
      }, timeoutMs);

      const handleStdoutClean = (text) => {
        if (promotedJob) {
          promotedJob.stdoutTail = appendTail(promotedJob.stdoutTail, text);
        } else {
          stdoutCap.push(text);
        }
      };

      const stdoutDecoder = usePty
        ? createConPtyOutputProcessor({
            cols,
            rows,
            onTerminal: (text) => process.stdout.write(text),
            onCleanText: handleStdoutClean,
          })
        : createAdaptiveStreamDecoder((text) => {
            handleStdoutClean(text);
            process.stdout.write(text);
          });
      const stderrDecoder = createAdaptiveStreamDecoder((text) => {
        if (promotedJob) {
          promotedJob.stderrTail = appendTail(promotedJob.stderrTail, text);
        } else {
          stderrCap.push(text);
        }
        process.stderr.write(text);
      });

      child.stdout.on("data", (chunk) => {
        stdoutDecoder.push(chunk);
      });
      child.stdout.on("end", () => {
        stdoutDecoder.flush();
      });
      child.stderr.on("data", (chunk) => {
        stderrDecoder.push(chunk);
      });
      child.stderr.on("end", () => {
        stderrDecoder.flush();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        stdoutDecoder.flush();
        stderrDecoder.flush();
        if (activeBatchChild === child) {
          activeBatchChild = null;
          activeBatchInfo = null;
        }
        if (promotedJob) {
          promotedJob.status = "failed";
          promotedJob.stderrTail = appendTail(promotedJob.stderrTail, error.message);
        }
        finish(error);
      });
      child.on("close", (code, signal) => {
        childExited = true;
        clearTimeout(timer);
        stdoutDecoder.flush();
        stderrDecoder.flush();
        if (activeBatchChild === child) {
          activeBatchChild = null;
          activeBatchInfo = null;
        }
        if (promotedJob) {
          promotedJob.status =
            promotedJob.status === "stopping"
              ? "stopped"
              : promotedJob.status === "failed"
                ? "failed"
                : "completed";
          promotedJob.endedAt = new Date().toISOString();
          promotedJob.exitCode = code;
          promotedJob.signal = signal;
          void (async () => {
            await persistBatchCwd(cwdOutPath);
            await rm(scriptPath, { force: true });
            if (cwdOutPath) await rm(cwdOutPath, { force: true });
          })();
          writeTerminal(
            `\r\n=== [Antigravity Job Exited] ${promotedJob.jobId} (code ${code ?? -1}) ===\r\n`,
          );
          resolveChildClosed();
          pruneCompletedJobs();
        } else {
          resolveChildClosed();
          finish(null, { promoted: false, code, signal });
        }
      });
    });

    const durationMs = Date.now() - started;

    if (result.promoted && result.job) {
      return {
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: true,
        killed: false,
        promotedToJob: true,
        jobId: result.job.jobId,
        pid: result.job.pid,
        status: result.job.status,
        durationMs,
        shell,
        pty: usePty,
        elevated,
        cwd: currentCwd,
        executedCwd: cwd,
        stdout: stdoutCap.text(),
        stderr: stderrCap.text(),
        stdoutTruncated: stdoutCap.truncated(),
        stderrTruncated: stderrCap.truncated(),
      };
    }

    await persistBatchCwd(cwdOutPath);
    writeTerminal(
      `=== [Batch Complete] exit ${result.code ?? -1}, ${durationMs} ms, cwd: ${currentCwd} ===\r\n`,
    );
    return {
      ok: !timedOut && result.code === 0,
      exitCode: result.code ?? -1,
      signal: result.signal,
      timedOut,
      killed,
      promotedToJob: false,
      durationMs,
      shell,
      pty: usePty,
      elevated,
      cwd: currentCwd,
      executedCwd: cwd,
      stdout: stdoutCap.text(),
      stderr: stderrCap.text(),
      stdoutTruncated: stdoutCap.truncated(),
      stderrTruncated: stderrCap.truncated(),
    };
  } finally {
    if (!promotedJob) {
      await rm(scriptPath, { force: true });
      if (cwdOutPath) await rm(cwdOutPath, { force: true });
    }
  }
}

async function handleRequest(request, context = {}) {
  if (
    request.type === "external-pairing-probe" ||
    request.type === "pair-external-terminal"
  ) {
    if (!externalPairingCode || !pendingDescriptor || Date.now() > Date.parse(pairingExpiresAt)) {
      throw new Error(
        "external terminal pairing code expired or already consumed; restart this bridge to generate a new code",
      );
    }
    if (
      typeof request?.ownerKey !== "string" ||
      typeof request?.conversationId !== "string" ||
      typeof request?.targetName !== "string"
    ) {
      throw new Error("invalid Antigravity pairing request");
    }
    const proof = externalPairingProof(
      identityKey,
      pendingDescriptor,
      request.ownerKey,
      externalPairingCode,
    );
    if (!proofsMatch(proof, request.pairingProof)) {
      throw new Error("external terminal pairing authentication failed");
    }
    if (ownerKey && ownerKey !== request.ownerKey) {
      throw new Error("external terminal is already bound to another Antigravity session");
    }
    if (request.type === "external-pairing-probe") {
      return { sessionId, pairingProof: proof, boundOwnerKey: ownerKey };
    }
    await bindToOwner(request.ownerKey, request.conversationId, request.targetName);
    clearPairingExpiryTimer();
    externalPairingCode = null;
    pendingDescriptor = null;
    await removeOwnPairingFile();
    setTerminalTitle(
      `Antigravity Bridge [${elevated ? "ADMIN" : "USER"}] - Paired (${request.targetName})`,
    );
    writeTerminal(
      `\r\n[External Bridge] Paired with Antigravity conversation ${request.conversationId} (target: ${request.targetName}). Pairing code consumed.\r\n`,
    );
    return {
      sessionId,
      ownerKey,
      conversationId,
      targetName,
      paired: true,
      elevated,
      username,
      cwd: currentCwd,
      shell: defaultShell,
      label: descriptor.label,
    };
  }

  authorize(request);

  if (request.type === "status") {
    return {
      ok: true,
      online: true,
      paired: true,
      ownerKey,
      conversationId,
      targetName,
      sessionId,
      pid: process.pid,
      cwd: currentCwd,
      initialCwd,
      startedAt,
      transport: connection.transport,
      host: connection.host,
      port: connection.port,
      elevated,
      inWindowsTerminal: Boolean(process.env.WT_SESSION),
      ptySupported,
      ptyDefault: defaultUsePty,
      username,
      defaultShell,
      label: descriptor.label,
      batchBusy: Boolean(activeBatchChild),
      activeBatch: activeBatchInfo
        ? {
            ...activeBatchInfo,
            elapsedMs: Math.max(0, Date.now() - Date.parse(activeBatchInfo.startedAt)),
          }
        : null,
      runningJobs: [...jobs.values()].filter((job) => job.status === "running").length,
      totalJobs: jobs.size,
    };
  }
  if (request.type === "run") {
    if (activeBatchChild) {
      const elapsedSec = activeBatchInfo
        ? Math.round((Date.now() - Date.parse(activeBatchInfo.startedAt)) / 1000)
        : 0;
      throw new Error(
        `this external terminal is already running a synchronous batch (PID ${activeBatchChild.pid}, running ${elapsedSec}s). Check bridge_status / list_terminal_jobs, or wait briefly for it to complete or auto-promote to a managed job.`,
      );
    }
    return runBatch(request, context);
  }
  if (request.type === "start-job") {
    return startLongRunningCommand(request);
  }
  if (request.type === "list-jobs") {
    return { jobs: listJobs() };
  }
  if (request.type === "get-job") {
    return getJob(request.jobId);
  }
  if (request.type === "send-job-input") {
    return sendJobInput(request.jobId, request.input, request.appendNewline !== false);
  }
  if (request.type === "stop-job") {
    return stopJob(request.jobId);
  }
  if (request.type === "disconnect") {
    const prevOwner = ownerKey;
    const prevSession = sessionId;
    const shouldShutdown = Boolean(request.shutdown);
    const shouldReopen = !shouldShutdown && request.reopenForPairing !== false;

    if (prevOwner) {
      await removeOwnBindingDescriptor(prevOwner, prevSession);
    }
    ownerKey = null;
    conversationId = null;
    targetName = null;
    descriptor = null;
    expectedProof = null;

    if (shouldShutdown) {
      writeTerminal("\r\n[External Bridge] Disconnected and shutting down as requested.\r\n");
      setTimeout(() => {
        void shutdown();
      }, 80);
      return { disconnected: true, shutdown: true, reopenedForPairing: false };
    }

    if (shouldReopen) {
      await openPairingWindow();
      setTerminalTitle(
        `Antigravity Bridge [${elevated ? "ADMIN" : "USER"}] - Waiting to Pair`,
      );
      writeTerminal(
        [
          "",
          "[External Bridge] Disconnected from previous Antigravity session.",
          `New Pairing Code: ${externalPairingCode}`,
          `Expires At:       ${pairingExpiresAt}`,
          ...(pairingFilePath ? [`Pairing File:     ${pairingFilePath}`] : []),
          "",
        ].join("\r\n"),
      );
      return {
        disconnected: true,
        shutdown: false,
        reopenedForPairing: true,
        pairingExpiresAt,
      };
    }

    writeTerminal("\r\n[External Bridge] Disconnected.\r\n");
    return { disconnected: true, shutdown: false, reopenedForPairing: false };
  }

  throw new Error(`unknown bridge request type: ${request?.type}`);
}

const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(15000, () => socket.destroy());
  let input = "";
  let responseSent = false;
  const disconnectHandlers = [];

  socket.on("close", () => {
    if (!responseSent) {
      for (const handler of disconnectHandlers) {
        try {
          handler();
        } catch {
          // Ignore disconnect handler errors.
        }
      }
    }
  });

  socket.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;

    const line = input.slice(0, newline).trim();
    socket.pause();
    socket.setTimeout(0);

    void (async () => {
      try {
        const request = JSON.parse(line);
        const result = await handleRequest(request, {
          onClientDisconnect: (fn) => disconnectHandlers.push(fn),
        });
        responseSent = true;
        if (!socket.destroyed) {
          socket.end(`${JSON.stringify({ ok: true, result })}\n`);
        }
      } catch (error) {
        responseSent = true;
        if (!socket.destroyed) {
          socket.end(
            `${JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })}\n`,
          );
        }
      }
    })();
  });
});

server.on("error", (error) => {
  void (async () => {
    clearPairingExpiryTimer();
    await removeOwnState();
    process.stderr.write(`Bridge server error: ${error.stack || error}\r\n`);
    process.exitCode = 1;
  })();
});

async function initializeBridge() {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("external terminal loopback endpoint is unavailable");
  }
  connection = {
    transport: "tcp",
    host: "127.0.0.1",
    port: address.port,
  };
  await openPairingWindow();
  setTerminalTitle(
    `Antigravity Bridge [${elevated ? "ADMIN" : "USER"}] - Waiting to Pair`,
  );

  const lines = [
    "================================================================",
    ` Antigravity External Terminal Bridge Ready (${elevated ? "ADMINISTRATOR" : "Standard User"})`,
    "================================================================",
    `PID:           ${process.pid}`,
    `User:          ${username}`,
    `Privileges:    ${elevated ? "ELEVATED (Administrator / 管理员权限)" : "Standard User (普通用户权限)"}`,
    `Default Shell: ${defaultShell}`,
    `CWD:           ${currentCwd}`,
    `Endpoint:      127.0.0.1:${connection.port} (loopback only)`,
    ...(terminalLabel ? [`Label:         ${terminalLabel}`] : []),
    ...(elevated
      ? [
          "WARNING:       Commands from the paired Antigravity session will run with Administrator privileges!",
        ]
      : []),
    `Pairing code:  ${externalPairingCode}`,
    `Expires at:    ${pairingExpiresAt}`,
    ...(pairingFilePath ? [`Pairing file:  ${pairingFilePath}`] : []),
    "----------------------------------------------------------------",
    pairingFilePath
      ? "Tell Antigravity to connect to the external terminal (no need to copy the code)."
      : "Send this one-time pairing code to Antigravity to connect.",
    "The pairing code and file are automatically deleted after pairing.",
    "Press Ctrl+C to stop.",
    "",
  ];
  writeTerminal(lines.join("\r\n"));
}

server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
  void initializeBridge().catch((error) => {
    void (async () => {
      clearPairingExpiryTimer();
      await removeOwnState();
      process.stderr.write(
        `Bridge initialization error: ${error.stack || error}\r\n`,
      );
      server.close();
      process.exitCode = 1;
    })();
  });
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearPairingExpiryTimer();
  if (activeBatchChild) {
    void terminateProcessTree(activeBatchChild.pid);
  }
  for (const record of jobs.values()) {
    if (record.status === "running") {
      void terminateProcessTree(record.pid);
    }
  }
  server.close();
  await removeOwnState();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
