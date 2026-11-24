import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  authenticationProof,
  conversationIdPattern,
  defaultPairingFilePath,
  externalPairingCodeHash,
  externalPairingProof,
  getOrCreateIdentityKey,
  listBindingsForConversation,
  listPending,
  makeOwnerKey,
  normalizeConversationId,
  normalizeExternalPairingCode,
  normalizeTargetName,
  proofsMatch,
  readBindingDescriptor,
  sendBridgeJson,
  stateRoot,
  targetNamePattern,
} from "./bridge-common.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const launchScriptPath = join(scriptDir, "launch-external-terminal.ps1");
const startExternalCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(
  scriptDir,
  "start-external-bridge.ps1",
)}"`;
const startAdminCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(
  scriptDir,
  "start-admin-bridge.ps1",
)}"`;
const retryDelayMs = 100;

function bridgeUnavailable(targetName, error) {
  return new Error(
    `No active external terminal is paired for target "${targetName}" (${error instanceof Error ? error.message : String(error)}).\n` +
      `You can call launch_external_terminal (with elevated: true to request Windows UAC elevation for an Administrator terminal, or elevated: false for a standard terminal), ` +
      `or ask the user to start the bridge manually:\n` +
      `- Standard or already-elevated terminal: ${startExternalCommand}\n` +
      `- Launch a new Administrator terminal (UAC): ${startAdminCommand}`,
  );
}

async function requestBridge(conversationId, targetName, payload, timeoutMs) {
  const conv = normalizeConversationId(conversationId);
  const target = normalizeTargetName(targetName);
  const ownerKey = makeOwnerKey(conv, target);
  const key = await getOrCreateIdentityKey();
  const discoveryDeadline = Date.now() + Math.min(timeoutMs, 3000);
  let lastError = null;

  while (Date.now() <= discoveryDeadline) {
    try {
      const descriptor = await readBindingDescriptor(ownerKey);
      const authProof = authenticationProof(key, descriptor);
      const envelope = await sendBridgeJson(
        descriptor,
        {
          ...payload,
          ownerKey,
          sessionId: descriptor.sessionId,
          authProof,
        },
        timeoutMs,
      );
      if (!envelope.ok) {
        const error = new Error(envelope.error || "bridge request failed");
        error.retryable = false;
        throw error;
      }
      return { descriptor, result: envelope.result };
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || error?.code === "ENOENT") {
        throw error?.code === "ENOENT"
          ? bridgeUnavailable(target, new Error("not paired yet"))
          : error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw bridgeUnavailable(target, lastError);
}

async function readPairingCodeFromFile(pairingFile) {
  try {
    const raw = await readFile(pairingFile, "utf8");
    const record = JSON.parse(raw);
    if (
      record?.version !== 1 ||
      record?.mode !== "external" ||
      typeof record?.pairingCode !== "string" ||
      typeof record?.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(record.expiresAt))
    ) {
      return {
        ok: false,
        reason: "invalid-external-pairing-file",
        diagnostic: { pairingFile },
      };
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await rm(pairingFile, { force: true });
      return {
        ok: false,
        reason: "expired-external-pairing-file",
        diagnostic: { pairingFile, expiresAt: record.expiresAt },
      };
    }
    try {
      return {
        ok: true,
        pairingCode: normalizeExternalPairingCode(record.pairingCode),
        fileMetadata: record,
      };
    } catch {
      return {
        ok: false,
        reason: "invalid-external-pairing-file",
        diagnostic: { pairingFile },
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason:
        error?.code === "ENOENT"
          ? "external-pairing-file-not-found"
          : "invalid-external-pairing-file",
      diagnostic: { pairingFile, errorCode: error?.code ?? "PARSE_ERROR" },
    };
  }
}

async function pairExternalTerminal({
  conversationId,
  targetName,
  pairingCode,
  pairingFile,
}) {
  const conv = normalizeConversationId(conversationId);
  const target = normalizeTargetName(targetName);
  const ownerKey = makeOwnerKey(conv, target);
  const key = await getOrCreateIdentityKey();

  let normalizedCode = null;
  let source = "pairingCode";
  let resolvedFile = null;

  if (pairingCode && pairingCode.trim() !== "") {
    normalizedCode = normalizeExternalPairingCode(pairingCode);
  } else {
    source = "pairingFile";
    resolvedFile = pairingFile?.trim() || defaultPairingFilePath();
    const loaded = await readPairingCodeFromFile(resolvedFile);
    if (!loaded.ok) {
      return {
        paired: false,
        ownerKey,
        conversationId: conv,
        targetName: target,
        reason: loaded.reason,
        diagnostic: loaded.diagnostic,
        guidance: `Start the external terminal bridge first:\n- Current terminal: ${startExternalCommand}\n- New Administrator terminal: ${startAdminCommand}`,
      };
    }
    normalizedCode = loaded.pairingCode;
  }

  const expectedCodeHash = externalPairingCodeHash(key, normalizedCode);
  const reachable = [];
  let matchedCandidates = 0;
  const connectionErrorCodes = new Set();

  for (const pending of await listPending()) {
    if (
      Date.parse(pending.pairingExpiresAt) <= Date.now() ||
      !proofsMatch(expectedCodeHash, pending.pairingCodeHash)
    ) {
      continue;
    }
    matchedCandidates += 1;
    const proof = externalPairingProof(key, pending, ownerKey, normalizedCode);
    try {
      const envelope = await sendBridgeJson(
        pending,
        {
          type: "external-pairing-probe",
          ownerKey,
          conversationId: conv,
          targetName: target,
          pairingProof: proof,
        },
        2500,
      );
      if (
        envelope.ok &&
        envelope.result?.sessionId === pending.sessionId &&
        proofsMatch(proof, envelope.result?.pairingProof)
      ) {
        reachable.push({ pending, proof });
      }
    } catch (error) {
      connectionErrorCodes.add(
        typeof error?.code === "string" ? error.code : "UNKNOWN",
      );
    }
  }

  if (reachable.length === 0) {
    const reason =
      matchedCandidates > 0
        ? "external-terminal-found-but-unreachable"
        : "no-live-external-terminal-for-pairing-code";
    return {
      paired: false,
      ownerKey,
      conversationId: conv,
      targetName: target,
      source,
      pairingFile: resolvedFile,
      reason,
      diagnostic: {
        matchedCandidates,
        connectionErrorCodes: [...connectionErrorCodes],
      },
      guidance: `Restart the external bridge in the target terminal:\n- Current terminal: ${startExternalCommand}\n- New Administrator terminal: ${startAdminCommand}`,
    };
  }

  if (reachable.length > 1) {
    return {
      paired: false,
      ownerKey,
      conversationId: conv,
      targetName: target,
      reason: "ambiguous-external-pairing-code",
    };
  }

  const { pending, proof } = reachable[0];
  const pairEnvelope = await sendBridgeJson(
    pending,
    {
      type: "pair-external-terminal",
      ownerKey,
      conversationId: conv,
      targetName: target,
      pairingProof: proof,
    },
    5000,
  );
  if (!pairEnvelope.ok) {
    return {
      paired: false,
      ownerKey,
      conversationId: conv,
      targetName: target,
      reason: pairEnvelope.error || "external-pairing-rejected",
    };
  }

  const { result: status } = await requestBridge(conv, target, { type: "status" }, 5000);
  return {
    paired: true,
    reason: "paired-external-terminal",
    source,
    ...status,
  };
}

function runLauncherProcess(args, timeoutMs = 60000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launchScriptPath,
        ...args,
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`launcher timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function launchExternalTerminal({
  conversationId,
  targetName,
  elevated = false,
  cwd,
  shell,
  label,
  useWindowsTerminal = true,
  keepOpenOnExit = false,
  hiddenWindow = false,
  autoPair = true,
  reuseIfOnline = true,
  waitTimeoutMs = 45000,
}) {
  const conv = normalizeConversationId(conversationId);
  const target = normalizeTargetName(targetName);
  const effectiveCwd = cwd?.trim() || homedir();
  if (!existsSync(effectiveCwd)) {
    throw new Error(`working directory does not exist: ${effectiveCwd}`);
  }

  if (reuseIfOnline) {
    try {
      const { result: existing } = await requestBridge(conv, target, { type: "status" }, 2000);
      if (existing?.ok && (!elevated || existing.elevated === true)) {
        return {
          launched: false,
          reused: true,
          paired: true,
          reason: "reused-existing-online-terminal",
          ...existing,
        };
      }
    } catch {
      // No reusable online terminal for this target; proceed to launch.
    }
  }

  const launchesDir = join(stateRoot, "launches");
  await mkdir(launchesDir, { recursive: true });
  const dedicatedPairingFile = autoPair
    ? join(launchesDir, `pairing-${randomUUID()}.json`)
    : defaultPairingFilePath();

  const launchArgs = [
    "-WorkingDirectory",
    effectiveCwd,
    "-PairingFile",
    dedicatedPairingFile,
    "-StateRoot",
    stateRoot,
  ];
  if (elevated) launchArgs.push("-Elevated");
  if (label?.trim()) launchArgs.push("-Label", label.trim());
  if (shell) launchArgs.push("-Shell", shell);
  if (useWindowsTerminal) launchArgs.push("-UseWindowsTerminal");
  if (keepOpenOnExit) launchArgs.push("-KeepOpenOnExit");
  if (hiddenWindow && !elevated) launchArgs.push("-HiddenWindow");

  const launchResult = await runLauncherProcess(
    launchArgs,
    Math.max(waitTimeoutMs, 60000),
  );

  if (launchResult.code !== 0) {
    if (autoPair) await rm(dedicatedPairingFile, { force: true });
    if (
      launchResult.code === 1223 ||
      launchResult.stderr.includes("UAC_CANCELLED")
    ) {
      return {
        launched: false,
        reused: false,
        paired: false,
        elevated,
        conversationId: conv,
        targetName: target,
        reason: "uac-cancelled-by-user",
        message: "The user declined or canceled the Windows UAC elevation prompt.",
      };
    }
    return {
      launched: false,
      reused: false,
      paired: false,
      elevated,
      conversationId: conv,
      targetName: target,
      reason: "launch-failed",
      exitCode: launchResult.code,
      stdout: launchResult.stdout,
      stderr: launchResult.stderr,
    };
  }

  let launchMeta = {};
  try {
    launchMeta = JSON.parse(launchResult.stdout);
  } catch {
    // Non-JSON stdout is harmless.
  }

  if (!autoPair) {
    return {
      launched: true,
      reused: false,
      paired: false,
      elevated,
      usedWindowsTerminal: Boolean(launchMeta.usedWindowsTerminal),
      conversationId: conv,
      targetName: target,
      pairingFile: dedicatedPairingFile,
      reason: "launched-awaiting-manual-pair",
    };
  }

  const deadline = Date.now() + waitTimeoutMs;
  let lastPairAttempt = null;
  try {
    while (Date.now() <= deadline) {
      const attempt = await pairExternalTerminal({
        conversationId: conv,
        targetName: target,
        pairingFile: dedicatedPairingFile,
      });
      lastPairAttempt = attempt;
      if (attempt.paired) {
        return {
          launched: true,
          reused: false,
          usedWindowsTerminal: Boolean(launchMeta.usedWindowsTerminal),
          ...attempt,
        };
      }
      if (
        attempt.reason !== "external-pairing-file-not-found" &&
        attempt.reason !== "invalid-external-pairing-file" &&
        attempt.reason !== "no-live-external-terminal-for-pairing-code"
      ) {
        return {
          launched: true,
          reused: false,
          ...attempt,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      launched: true,
      reused: false,
      paired: false,
      elevated,
      conversationId: conv,
      targetName: target,
      reason: "launch-pairing-timeout",
      waitTimeoutMs,
      lastReason: lastPairAttempt?.reason ?? null,
    };
  } finally {
    await rm(dedicatedPairingFile, { force: true });
  }
}

const conversationIdSchema = z
  .string()
  .regex(conversationIdPattern)
  .describe(
    "Current Antigravity conversation ID (UUID from <user_information>), used to isolate terminal bindings per conversation.",
  );

const targetNameSchema = z
  .string()
  .regex(targetNamePattern)
  .optional()
  .describe(
    "Optional alias for the external terminal within this conversation (e.g., 'default', 'admin', 'dev'). Defaults to 'default'.",
  );

const shellSchema = z
  .enum(["powershell", "pwsh", "cmd"])
  .optional()
  .describe(
    "Optional shell override ('powershell', 'pwsh', or 'cmd'). Defaults to the shell used when starting the external bridge.",
  );

const jobIdSchema = z
  .string()
  .uuid()
  .describe("Job ID returned by start_long_running_command.");

const server = new McpServer(
  {
    name: "external-terminal-bridge",
    version: "1.2.0",
  },
  {
    instructions:
      "Use these tools to launch, pair, and operate user-selected external Windows Terminals (including Administrator elevated terminals) over authenticated loopback TCP (127.0.0.1). Always pass the current Antigravity Conversation ID as conversationId. When an Administrator external terminal is needed and not yet paired, call launch_external_terminal with elevated: true (after briefly informing the user that a Windows UAC elevation prompt will appear) to request user authorization via standard UAC and auto-pair once approved. To connect a terminal the user already started manually, call pair_external_terminal without asking them to paste the code — it reads Desktop pairing-code.json automatically. When elevated is true, confirm destructive or system-wide changes before execution. TIMEOUT RULE: run_command_batch is subject to the ~60s MCP synchronous timeout (default 45s, max 50s) and is ONLY for short commands (<30s). Any command that may take >=30s or has uncertain duration (DISM, sfc, installers/drivers, large builds, long tests, servers, watchers) MUST use start_long_running_command + get_terminal_job_output (with schedule for periodic checks instead of tight polling). If run_command_batch hits its sync timeout, it automatically promotes the running process to a managed job (returning jobId and releasing batchBusy) unless killOnTimeout is true.",
  },
);

server.registerTool(
  "launch_external_terminal",
  {
    title: "Launch and auto-pair an external terminal (supports Windows UAC)",
    description:
      "Launch a new visible external terminal window (standard or Administrator via standard Windows UAC prompt) and automatically pair it to the current Antigravity conversation once the user approves UAC. Reuses an already-online terminal of matching/higher privilege by default.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      elevated: z
        .boolean()
        .optional()
        .describe("If true, trigger a standard Windows UAC elevation prompt (-Verb RunAs) to open an Administrator terminal. Defaults to false."),
      cwd: z
        .string()
        .optional()
        .describe("Initial working directory for the launched external terminal. Defaults to the current user's home directory."),
      shell: shellSchema,
      label: z
        .string()
        .max(120)
        .optional()
        .describe("Optional human-readable label displayed in the terminal banner."),
      useWindowsTerminal: z
        .boolean()
        .optional()
        .describe("Prefer opening in Windows Terminal (wt.exe) when available for standard mode. Defaults to true."),
      keepOpenOnExit: z
        .boolean()
        .optional()
        .describe("Keep the external terminal window open after the bridge exits (-NoExit). Defaults to false."),
      hiddenWindow: z
        .boolean()
        .optional()
        .describe("Only for non-elevated automated testing. Ignored when elevated is true."),
      autoPair: z
        .boolean()
        .optional()
        .describe("Automatically wait for the launched bridge and complete pairing. Defaults to true."),
      reuseIfOnline: z
        .boolean()
        .optional()
        .describe("If targetName is already online with sufficient privilege, reuse it instead of launching a new window / UAC prompt. Defaults to true."),
      waitTimeoutMs: z
        .number()
        .int()
        .min(5000)
        .max(120000)
        .optional()
        .describe("Maximum time in milliseconds to wait for UAC approval and auto-pairing. Defaults to 45000."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async (params) => {
    try {
      const result = await launchExternalTerminal(params);
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: params.autoPair === false ? !result.launched : !result.paired,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "pair_external_terminal",
  {
    title: "Pair an external Windows Terminal",
    description:
      "Pair the current Antigravity conversation with a user-started external terminal bridge (standard or Administrator). By default reads Desktop pairing-code.json automatically; optionally accepts an explicit pairingCode or pairingFile.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      pairingCode: z
        .string()
        .optional()
        .describe("Optional manual pairing code fallback (six groups of four hex characters). Omit to auto-read Desktop pairing-code.json."),
      pairingFile: z
        .string()
        .optional()
        .describe("Optional custom path to pairing-code.json. Defaults to the current user's Desktop pairing-code.json."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ conversationId, targetName, pairingCode, pairingFile }) => {
    try {
      const result = await pairExternalTerminal({
        conversationId,
        targetName,
        pairingCode,
        pairingFile,
      });
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.paired,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "bridge_status",
  {
    title: "Check paired external terminal status",
    description:
      "Check whether the paired external terminal is online, whether it has Administrator privileges (elevated), its current working directory, shell, and active jobs.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      listAllForConversation: z
        .boolean()
        .optional()
        .describe("If true, probe and list all external terminals bound to this conversationId."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ conversationId, targetName, listAllForConversation }) => {
    try {
      if (listAllForConversation) {
        const bindings = await listBindingsForConversation(conversationId);
        const key = await getOrCreateIdentityKey();
        const terminals = [];
        for (const descriptor of bindings) {
          try {
            const envelope = await sendBridgeJson(
              descriptor,
              {
                type: "status",
                ownerKey: descriptor.ownerKey,
                sessionId: descriptor.sessionId,
                authProof: authenticationProof(key, descriptor),
              },
              2000,
            );
            terminals.push(
              envelope.ok
                ? { online: true, ...envelope.result }
                : {
                    online: false,
                    targetName: descriptor.targetName,
                    sessionId: descriptor.sessionId,
                    elevated: descriptor.elevated,
                    error: envelope.error || "status rejected",
                  },
            );
          } catch (error) {
            terminals.push({
              online: false,
              targetName: descriptor.targetName,
              sessionId: descriptor.sessionId,
              elevated: descriptor.elevated,
              cwd: descriptor.cwd,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const payload = { conversationId: normalizeConversationId(conversationId), terminals };
        return {
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      }

      const { result } = await requestBridge(
        conversationId,
        targetName,
        { type: "status" },
        5000,
      );
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "run_command_batch",
  {
    title: "Run short finite commands in the paired external terminal",
    description:
      "Execute 1 to 50 SHORT finite commands (<30s total) sequentially in the paired external terminal (inheriting Administrator privileges if elevated). WARNING: Synchronous MCP tool calls have a ~60s client timeout (this tool defaults to 45000 ms, max 50000 ms). NEVER use run_command_batch for commands that may exceed 30-45s (such as DISM, sfc, driver/software installs, large builds, or long test suites) — use start_long_running_command + get_terminal_job_output instead. By default, if a batch exceeds timeoutMs, it automatically promotes the still-running process to a managed background job (returning jobId and releasing batchBusy) instead of hanging or killing the process.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      commands: z
        .array(z.string().min(1).max(32768))
        .min(1)
        .max(50)
        .describe("Ordered list of short (<30s) finite commands to execute."),
      cwd: z
        .string()
        .optional()
        .describe("Optional one-shot working directory override. Omit to use and persist the external terminal's current directory."),
      shell: shellSchema,
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(50000)
        .optional()
        .describe("Synchronous wait timeout in milliseconds (1000-50000). Defaults to 45000 to stay safely under MCP's ~60s sync limit."),
      killOnTimeout: z
        .boolean()
        .optional()
        .describe("If true, terminate the process tree on timeout instead of promoting it to a managed background job. Defaults to false."),
      persistCwd: z
        .boolean()
        .optional()
        .describe("Persist working directory changes (e.g. cd/Set-Location) to subsequent commands when cwd is not overridden. Defaults to true."),
      pty: z
        .boolean()
        .optional()
        .describe("Run inside a Windows ConPTY pseudo-console so native progress bars (DISM, sfc, winget, Write-Progress) update in-place. Defaults to true in interactive external terminals."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  async ({ conversationId, targetName, commands, cwd, shell, timeoutMs, killOnTimeout, persistCwd, pty }) => {
    try {
      const effectiveTimeout = Math.min(timeoutMs ?? 45000, 50000);
      const { descriptor, result } = await requestBridge(
        conversationId,
        targetName,
        {
          type: "run",
          commands,
          cwd,
          shell,
          timeoutMs: effectiveTimeout,
          killOnTimeout: Boolean(killOnTimeout),
          persistCwd,
          pty,
        },
        effectiveTimeout + 5000,
      );
      const structured = {
        conversationId: descriptor.conversationId,
        targetName: descriptor.targetName,
        sessionId: descriptor.sessionId,
        ...result,
      };
      if (result.promotedToJob) {
        return {
          structuredContent: structured,
          content: [
            {
              type: "text",
              text: [
                `External terminal (${descriptor.targetName}, ${result.elevated ? "ADMIN" : "standard"}) exceeded synchronous wait limit (${effectiveTimeout} ms) and was automatically promoted to managed background job ${result.jobId} (PID ${result.pid}).`,
                "batchBusy has been released and the process continues running safely in the external terminal.",
                `Use get_terminal_job_output (with jobId "${result.jobId}", combined with schedule instead of tight polling) to check progress/completion, or stop_terminal_job to terminate it.`,
                result.stdout ? `stdout so far:\n${result.stdout}` : "",
                result.stderr ? `stderr so far:\n${result.stderr}` : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
          isError: false,
        };
      }
      return {
        structuredContent: structured,
        content: [
          {
            type: "text",
            text: [
              `External terminal (${descriptor.targetName}, ${result.elevated ? "ADMIN" : "standard"}) finished with exit code ${result.exitCode} in ${result.durationMs} ms (cwd: ${result.cwd}).`,
              result.stdout ? `stdout:\n${result.stdout}` : "",
              result.stderr ? `stderr:\n${result.stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        isError: !result.ok,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "start_long_running_command",
  {
    title: "Start a long-running or slow command in the paired external terminal",
    description:
      "REQUIRED for any command that may take >=30s or has uncertain duration (e.g., DISM, sfc, software/driver installation, large builds, long test suites, dev servers, watchers, log followers, or interactive CLIs). Returns a jobId immediately without waiting for exit; output streams live in the external terminal. Monitor with get_terminal_job_output (paired with schedule instead of tight polling) and terminate with stop_terminal_job.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      command: z
        .string()
        .min(1)
        .max(32768)
        .describe("The single long-running command to start."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory. Defaults to the external terminal's current working directory."),
      shell: shellSchema,
      startupGraceMs: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe("Brief observation window before returning. Defaults to 350 ms."),
      pty: z
        .boolean()
        .optional()
        .describe("Run inside a Windows ConPTY pseudo-console for native in-place progress bars and TTY output. Defaults to true in interactive external terminals."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  async ({ conversationId, targetName, command, cwd, shell, startupGraceMs, pty }) => {
    try {
      const { result } = await requestBridge(
        conversationId,
        targetName,
        {
          type: "start-job",
          command,
          cwd,
          shell,
          startupGraceMs,
          pty,
        },
        10000,
      );
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text:
              result.status === "running"
                ? `Started external terminal job ${result.jobId} (PID ${result.pid}, shell ${result.shell}). Output continues streaming in the paired external terminal.`
                : `External terminal job ${result.jobId} exited during startup with code ${result.exitCode}.\n${result.stdoutTail || ""}\n${result.stderrTail || ""}`.trim(),
          },
        ],
        isError:
          result.status !== "running" &&
          result.status !== "completed" &&
          result.exitCode !== 0,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "list_terminal_jobs",
  {
    title: "List long-running jobs in the paired external terminal",
    description:
      "List all managed long-running jobs (running and recently exited) in the paired external terminal.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ conversationId, targetName }) => {
    try {
      const { result } = await requestBridge(
        conversationId,
        targetName,
        { type: "list-jobs" },
        5000,
      );
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "get_terminal_job_output",
  {
    title: "Read recent output of a long-running job",
    description:
      "Inspect the current status, exit code, and latest stdout/stderr tail of a managed long-running job in the paired external terminal.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      jobId: jobIdSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ conversationId, targetName, jobId }) => {
    try {
      const { result } = await requestBridge(
        conversationId,
        targetName,
        { type: "get-job", jobId },
        5000,
      );
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "send_terminal_job_input",
  {
    title: "Send stdin text to a running job",
    description:
      "Write text to the standard input of a running long-running job in the paired external terminal (e.g., answering interactive CLI prompts).",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      jobId: jobIdSchema,
      input: z.string().max(8192).describe("Text to send to the job's stdin."),
      appendNewline: z
        .boolean()
        .optional()
        .describe("Whether to append CRLF after input. Defaults to true."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  async ({ conversationId, targetName, jobId, input, appendNewline }) => {
    try {
      const { result } = await requestBridge(
        conversationId,
        targetName,
        { type: "send-job-input", jobId, input, appendNewline },
        5000,
      );
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "stop_terminal_job",
  {
    title: "Stop a long-running job in the paired external terminal",
    description:
      "Terminate a managed long-running job and its child process tree in the paired external terminal.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      jobId: jobIdSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  async ({ conversationId, targetName, jobId }) => {
    try {
      const { result } = await requestBridge(
        conversationId,
        targetName,
        { type: "stop-job", jobId },
        10000,
      );
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: `External terminal job ${jobId} status: ${result.status}.`,
          },
        ],
        isError: result.status === "running" || result.status === "stopping",
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "disconnect_terminal",
  {
    title: "Disconnect from a paired external terminal",
    description:
      "Unbind the current conversation from the target external terminal. Optionally shut down the external bridge process or reopen it with a fresh pairing code.",
    inputSchema: {
      conversationId: conversationIdSchema,
      targetName: targetNameSchema,
      shutdown: z
        .boolean()
        .optional()
        .describe("If true, stop the external terminal bridge process after unbinding. Defaults to false."),
      reopenForPairing: z
        .boolean()
        .optional()
        .describe("When shutdown is false, generate a fresh pairing code so another session can pair. Defaults to true."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ conversationId, targetName, shutdown, reopenForPairing }) => {
    try {
      const { result } = await requestBridge(
        conversationId,
        targetName,
        { type: "disconnect", shutdown, reopenForPairing },
        5000,
      );
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
