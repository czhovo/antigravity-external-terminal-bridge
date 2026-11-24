import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bridgeScript = join(pluginRoot, "scripts", "terminal-bridge.mjs");
const startExternalPs1 = join(pluginRoot, "scripts", "start-external-bridge.ps1");
const mcpServerScript = join(pluginRoot, "scripts", "mcp-server.mjs");

function startProcess(executable, arguments_, environment, cwd) {
  const child = spawn(executable, arguments_, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  return {
    child,
    output: () => output,
    errors: () => errors,
  };
}

async function waitForOutput(proc, pattern, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = proc.output().match(pattern);
    if (match) return match;
    if (proc.child.exitCode !== null) {
      throw new Error(
        `process exited before expected output (${proc.child.exitCode})\nSTDOUT:\n${proc.output()}\nSTDERR:\n${proc.errors()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(
    `timed out waiting for pattern ${pattern}\nSTDOUT:\n${proc.output()}\nSTDERR:\n${proc.errors()}`,
  );
}

async function stopProcess(proc) {
  if (!proc) return;
  const closed = proc.child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => proc.child.once("close", resolve));
  if (process.platform === "win32" && proc.child.pid) {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(proc.child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    await new Promise((resolve) => killer.once("close", resolve));
  } else if (proc.child.exitCode === null) {
    proc.child.kill();
  }
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
}

async function forceStopProcess(proc) {
  if (!proc || proc.child.exitCode !== null) return;
  const closed = new Promise((resolve) => proc.child.once("close", resolve));
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(proc.child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    await new Promise((resolve) => killer.once("close", resolve));
  } else {
    proc.child.kill("SIGKILL");
  }
  await closed;
}

async function createMcpClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerScript],
    env,
  });
  const client = new Client(
    { name: "external-terminal-bridge-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

test("end-to-end MCP workflow: launcher, auto-pairing, UTF-8, CWD persistence, interactive job, multi-target elevated, isolation, disconnect", async () => {
  const testRoot = join(tmpdir(), `agy-ext-bridge-e2e-${randomUUID()}`);
  const stateRoot = join(testRoot, "state");
  const pairingFile = join(testRoot, "pairing-code.json");
  const workDir = join(testRoot, "workspace");
  const subDir = join(workDir, "sub-folder");
  await mkdir(subDir, { recursive: true });

  const env = {
    ...process.env,
    ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT: stateRoot,
    ANTIGRAVITY_TERMINAL_BRIDGE_PAIRING_FILE: pairingFile,
  };

  const conversationId = randomUUID();
  const otherConversationId = randomUUID();
  const { client, transport } = await createMcpClient(env);

  let standardBridge = null;
  let elevatedBridge = null;

  try {
    // 1. Verify all 10 MCP tools are exposed
    const listed = await client.listTools();
    const toolNames = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "bridge_status",
      "disconnect_terminal",
      "get_terminal_job_output",
      "launch_external_terminal",
      "list_terminal_jobs",
      "pair_external_terminal",
      "run_command_batch",
      "send_terminal_job_input",
      "start_long_running_command",
      "stop_terminal_job",
    ]);

    // 2. Start external bridge via real start-external-bridge.ps1
    standardBridge = startProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        startExternalPs1,
        "-PairingFile",
        pairingFile,
        "-Label",
        "Standard Test Terminal",
      ],
      env,
      workDir,
    );
    const codeMatch = await waitForOutput(
      standardBridge,
      /Pairing code:\s+([0-9A-F]{4}(?:-[0-9A-F]{4}){5})/,
    );
    const firstCode = codeMatch[1];

    // 3. Auto-pair via MCP without passing pairingCode explicitly
    const pairResp = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId },
    });
    assert.ok(!pairResp.isError);
    assert.equal(pairResp.structuredContent.paired, true);
    assert.equal(pairResp.structuredContent.targetName, "default");
    assert.equal(pairResp.structuredContent.elevated, false);

    // Pairing file must be deleted and code cannot be reused
    await assert.rejects(
      readFile(pairingFile, "utf8"),
      (err) => err?.code === "ENOENT",
    );
    const replayResp = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId: otherConversationId, pairingCode: firstCode },
    });
    assert.equal(replayResp.isError, true);
    assert.equal(
      replayResp.structuredContent.reason,
      "no-live-external-terminal-for-pairing-code",
    );

    // 4. UTF-8 Chinese output + CWD persistence across batches + cmd shell support
    const batch1 = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        commands: [
          'Write-Output "外部终端中文测试_成功"',
          'Set-Location "sub-folder"',
        ],
      },
    });
    assert.ok(!batch1.isError);
    assert.match(batch1.structuredContent.stdout, /外部终端中文测试_成功/);
    assert.equal(batch1.structuredContent.cwd.toLowerCase(), subDir.toLowerCase());

    const batch2 = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        commands: ["(Get-Location).ProviderPath"],
      },
    });
    assert.ok(!batch2.isError);
    assert.ok(
      batch2.structuredContent.stdout.toLowerCase().includes("sub-folder"),
      `Expected persisted cwd to contain sub-folder, got: ${batch2.structuredContent.stdout}`,
    );

    const cmdBatch = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        shell: "cmd",
        commands: ["echo CMD_UTF8_测试_OK"],
      },
    });
    assert.ok(!cmdBatch.isError);
    assert.match(cmdBatch.structuredContent.stdout, /CMD_UTF8_测试_OK/);

    // 5. Conversation isolation: otherConversationId cannot access default terminal
    const isoResp = await client.callTool({
      name: "bridge_status",
      arguments: { conversationId: otherConversationId },
    });
    assert.equal(isoResp.isError, true);

    // 6. Long-running interactive job: start -> list -> send stdin -> get output -> stop
    const echoJobScript = join(workDir, "echo-job.mjs");
    await writeFile(
      echoJobScript,
      [
        'import readline from "node:readline";',
        'console.log("READY_FOR_INPUT");',
        "const rl = readline.createInterface({ input: process.stdin });",
        'rl.on("line", (line) => console.log("ECHO:" + line));',
        "",
      ].join("\n"),
      "utf8",
    );

    const startJob = await client.callTool({
      name: "start_long_running_command",
      arguments: {
        conversationId,
        command: `node "${echoJobScript}"`,
        startupGraceMs: 1000,
      },
    });
    assert.ok(!startJob.isError);
    assert.equal(startJob.structuredContent.status, "running");
    const jobId = startJob.structuredContent.jobId;

    const jobsList = await client.callTool({
      name: "list_terminal_jobs",
      arguments: { conversationId },
    });
    assert.ok(!jobsList.isError);
    assert.equal(jobsList.structuredContent.jobs.length, 1);

    const inputResp = await client.callTool({
      name: "send_terminal_job_input",
      arguments: {
        conversationId,
        jobId,
        input: "你好外部终端",
      },
    });
    assert.ok(!inputResp.isError);

    let jobOut = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      jobOut = await client.callTool({
        name: "get_terminal_job_output",
        arguments: { conversationId, jobId },
      });
      if (/ECHO:你好外部终端/.test(jobOut.structuredContent.stdoutTail || "")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(!jobOut.isError);
    assert.match(jobOut.structuredContent.stdoutTail, /ECHO:你好外部终端/);

    const stopResp = await client.callTool({
      name: "stop_terminal_job",
      arguments: { conversationId, jobId },
    });
    assert.ok(!stopResp.isError);
    assert.equal(stopResp.structuredContent.status, "stopped");

    // 7. Second terminal in same conversation with targetName "admin" and --elevated flag
    const adminPairingFile = join(testRoot, "admin-pairing-code.json");
    elevatedBridge = startProcess(
      process.execPath,
      [
        bridgeScript,
        "--elevated",
        "--pairing-file",
        adminPairingFile,
        "--label",
        "Admin Test Terminal",
      ],
      env,
      workDir,
    );
    await waitForOutput(
      elevatedBridge,
      /Pairing code:\s+([0-9A-F]{4}(?:-[0-9A-F]{4}){5})/,
    );

    const pairAdmin = await client.callTool({
      name: "pair_external_terminal",
      arguments: {
        conversationId,
        targetName: "admin",
        pairingFile: adminPairingFile,
      },
    });
    assert.ok(!pairAdmin.isError);
    assert.equal(pairAdmin.structuredContent.paired, true);
    assert.equal(pairAdmin.structuredContent.targetName, "admin");
    assert.equal(pairAdmin.structuredContent.elevated, true);

    const allStatus = await client.callTool({
      name: "bridge_status",
      arguments: { conversationId, listAllForConversation: true },
    });
    assert.ok(!allStatus.isError);
    assert.equal(allStatus.structuredContent.terminals.length, 2);
    const adminInfo = allStatus.structuredContent.terminals.find(
      (t) => t.targetName === "admin",
    );
    const defaultInfo = allStatus.structuredContent.terminals.find(
      (t) => t.targetName === "default",
    );
    assert.equal(adminInfo.online, true);
    assert.equal(adminInfo.elevated, true);
    assert.equal(defaultInfo.online, true);
    assert.equal(defaultInfo.elevated, false);

    // 8. Disconnect admin terminal with reopenForPairing=true, then re-pair it to otherConversationId
    const discAdmin = await client.callTool({
      name: "disconnect_terminal",
      arguments: {
        conversationId,
        targetName: "admin",
        shutdown: false,
        reopenForPairing: true,
      },
    });
    assert.ok(!discAdmin.isError);
    assert.equal(discAdmin.structuredContent.reopenedForPairing, true);

    const rePair = await client.callTool({
      name: "pair_external_terminal",
      arguments: {
        conversationId: otherConversationId,
        targetName: "reused-admin",
        pairingFile: adminPairingFile,
      },
    });
    assert.ok(!rePair.isError);
    assert.equal(rePair.structuredContent.paired, true);
    assert.equal(rePair.structuredContent.elevated, true);

    // 9. Disconnect with shutdown=true cleanly exits the bridge
    const shutResp = await client.callTool({
      name: "disconnect_terminal",
      arguments: {
        conversationId: otherConversationId,
        targetName: "reused-admin",
        shutdown: true,
      },
    });
    assert.ok(!shutResp.isError);
    assert.equal(shutResp.structuredContent.shutdown, true);
  } finally {
    await transport.close();
    await stopProcess(standardBridge);
    await stopProcess(elevatedBridge);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("diagnostics: missing, invalid, expired, and unreachable external pairing files", async () => {
  const testRoot = join(tmpdir(), `agy-ext-bridge-diag-${randomUUID()}`);
  const stateRoot = join(testRoot, "state");
  const pairingFile = join(testRoot, "pairing-code.json");
  const workDir = join(testRoot, "work");
  await mkdir(workDir, { recursive: true });

  const env = {
    ...process.env,
    ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT: stateRoot,
    ANTIGRAVITY_TERMINAL_BRIDGE_PAIRING_FILE: pairingFile,
  };
  const conversationId = randomUUID();
  const { client, transport } = await createMcpClient(env);
  let deadBridge = null;

  try {
    // Missing file
    const missing = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId },
    });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.reason, "external-pairing-file-not-found");

    // Corrupt JSON
    await writeFile(pairingFile, "not valid json\n", "utf8");
    const invalid = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId },
    });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.reason, "invalid-external-pairing-file");

    // Expired file gets removed automatically
    await writeFile(
      pairingFile,
      JSON.stringify({
        version: 1,
        mode: "external",
        pairingCode: "0000-0000-0000-0000-0000-0000",
        expiresAt: new Date(Date.now() - 5000).toISOString(),
      }),
      "utf8",
    );
    const expired = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId },
    });
    assert.equal(expired.isError, true);
    assert.equal(expired.structuredContent.reason, "expired-external-pairing-file");
    await assert.rejects(
      readFile(pairingFile, "utf8"),
      (err) => err?.code === "ENOENT",
    );

    // Force-killed bridge -> exact match but unreachable
    deadBridge = startProcess(
      process.execPath,
      [bridgeScript, "--pairing-file", pairingFile],
      env,
      workDir,
    );
    await waitForOutput(
      deadBridge,
      /Pairing code:\s+([0-9A-F]{4}(?:-[0-9A-F]{4}){5})/,
    );
    await forceStopProcess(deadBridge);

    const unreachable = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId },
    });
    assert.equal(unreachable.isError, true);
    assert.equal(
      unreachable.structuredContent.reason,
      "external-terminal-found-but-unreachable",
    );
    assert.equal(unreachable.structuredContent.diagnostic.matchedCandidates, 1);
  } finally {
    await transport.close();
    await forceStopProcess(deadBridge);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("launch_external_terminal auto-launches, auto-pairs, reuses online session, and shuts down cleanly", async () => {
  const testRoot = join(tmpdir(), `agy-ext-bridge-launch-${randomUUID()}`);
  const stateRoot = join(testRoot, "state");
  const workDir = join(testRoot, "work");
  await mkdir(workDir, { recursive: true });

  const env = {
    ...process.env,
    ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT: stateRoot,
  };
  const conversationId = randomUUID();
  const { client, transport } = await createMcpClient(env);

  try {
    const launched = await client.callTool({
      name: "launch_external_terminal",
      arguments: {
        conversationId,
        targetName: "auto",
        elevated: false,
        cwd: workDir,
        useWindowsTerminal: false,
        hiddenWindow: true,
        waitTimeoutMs: 20000,
      },
    });
    assert.ok(!launched.isError, `launch failed: ${JSON.stringify(launched)}`);
    assert.equal(launched.structuredContent.launched, true);
    assert.equal(launched.structuredContent.paired, true);
    assert.equal(launched.structuredContent.elevated, false);

    // Calling again with reuseIfOnline=true must reuse the existing terminal
    const reused = await client.callTool({
      name: "launch_external_terminal",
      arguments: {
        conversationId,
        targetName: "auto",
        elevated: false,
        cwd: workDir,
        reuseIfOnline: true,
      },
    });
    assert.ok(!reused.isError);
    assert.equal(reused.structuredContent.reused, true);
    assert.equal(reused.structuredContent.launched, false);
    assert.equal(reused.structuredContent.sessionId, launched.structuredContent.sessionId);

    const run = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        targetName: "auto",
        commands: ['Write-Output "AUTO_LAUNCH_OK"'],
      },
    });
    assert.ok(!run.isError);
    assert.match(run.structuredContent.stdout, /AUTO_LAUNCH_OK/);

    const shut = await client.callTool({
      name: "disconnect_terminal",
      arguments: {
        conversationId,
        targetName: "auto",
        shutdown: true,
      },
    });
    assert.ok(!shut.isError);
    assert.equal(shut.structuredContent.shutdown, true);
  } finally {
    await transport.close();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("run_command_batch and start_long_running_command decode GBK/CP936, UTF-8, mixed, and cross-chunk stdout/stderr cleanly", async () => {
  const testRoot = join(tmpdir(), `agy-ext-bridge-encoding-${randomUUID()}`);
  const stateRoot = join(testRoot, "state");
  const pairingFile = join(testRoot, "pairing-code.json");
  const workDir = join(testRoot, "work");
  await mkdir(workDir, { recursive: true });

  const emitterScript = join(workDir, "emit-mixed-encoding.mjs");
  await writeFile(
    emitterScript,
    [
      'const gbkDism = Buffer.from([0xce,0xb4,0xbc,0xec,0xb2,0xe2,0xb5,0xbd,0xd7,0xe9,0xbc,0xfe,0xb4,0xe6,0xb4,0xa2,0xcb,0xf0,0xbb,0xb5,0xa1,0xa3,0x0d,0x0a]);',
      'const gbkErr = Buffer.from([0xb2,0xd9,0xd7,0xf7,0xb3,0xc9,0xb9,0xa6,0xcd,0xea,0xb3,0xc9,0xa1,0xa3,0x0d,0x0a]);',
      'const utf8Line = Buffer.from("UTF8_前缀行：开始验证混合输出\\r\\n", "utf8");',
      'const utf8Tail = Buffer.from("UTF8_后缀行：验证完毕\\r\\n", "utf8");',
      'process.stdout.write(utf8Line);',
      '// Deliberately split a GBK multi-byte character across separate writes',
      'process.stdout.write(gbkDism.subarray(0, 5));',
      'setTimeout(() => {',
      '  process.stdout.write(gbkDism.subarray(5));',
      '  process.stdout.write(utf8Tail);',
      '  process.stderr.write(gbkErr.subarray(0, 3));',
      '  setTimeout(() => {',
      '    process.stderr.write(gbkErr.subarray(3));',
      '    if (process.argv.includes("--stay-alive")) {',
      '      setInterval(() => {}, 10000);',
      '    }',
      '  }, 40);',
      '}, 40);',
      "",
    ].join("\n"),
    "utf8",
  );

  const env = {
    ...process.env,
    ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT: stateRoot,
    ANTIGRAVITY_TERMINAL_BRIDGE_PAIRING_FILE: pairingFile,
  };
  const conversationId = randomUUID();
  const { client, transport } = await createMcpClient(env);
  let bridge = null;

  try {
    bridge = startProcess(
      process.execPath,
      [bridgeScript, "--pairing-file", pairingFile],
      env,
      workDir,
    );
    await waitForOutput(
      bridge,
      /Pairing code:\s+([0-9A-F]{4}(?:-[0-9A-F]{4}){5})/,
    );

    const paired = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId },
    });
    assert.ok(!paired.isError);

    // 1. Verify run_command_batch stdout + stderr + external terminal output
    const batch = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        commands: [`node "${emitterScript}"`],
      },
    });
    assert.ok(!batch.isError, `batch failed: ${JSON.stringify(batch)}`);
    assert.match(batch.structuredContent.stdout, /UTF8_前缀行：开始验证混合输出/);
    assert.match(batch.structuredContent.stdout, /未检测到组件存储损坏。/);
    assert.match(batch.structuredContent.stdout, /UTF8_后缀行：验证完毕/);
    assert.equal(batch.structuredContent.stdout.includes("\uFFFD"), false);
    assert.match(batch.structuredContent.stderr, /操作成功完成。/);
    assert.equal(batch.structuredContent.stderr.includes("\uFFFD"), false);
    assert.match(bridge.output(), /未检测到组件存储损坏。/);
    assert.equal(bridge.output().includes("\uFFFD"), false);

    // 2. Verify start_long_running_command stdoutTail + stderrTail
    const job = await client.callTool({
      name: "start_long_running_command",
      arguments: {
        conversationId,
        command: `node "${emitterScript}" --stay-alive`,
        startupGraceMs: 600,
      },
    });
    assert.ok(!job.isError);
    const jobId = job.structuredContent.jobId;

    let out = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      out = await client.callTool({
        name: "get_terminal_job_output",
        arguments: { conversationId, jobId },
      });
      if (
        /未检测到组件存储损坏。/.test(out.structuredContent.stdoutTail || "") &&
        /操作成功完成。/.test(out.structuredContent.stderrTail || "")
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(!out.isError);
    assert.match(out.structuredContent.stdoutTail, /UTF8_前缀行：开始验证混合输出/);
    assert.match(out.structuredContent.stdoutTail, /未检测到组件存储损坏。/);
    assert.match(out.structuredContent.stdoutTail, /UTF8_后缀行：验证完毕/);
    assert.equal(out.structuredContent.stdoutTail.includes("\uFFFD"), false);
    assert.match(out.structuredContent.stderrTail, /操作成功完成。/);
    assert.equal(out.structuredContent.stderrTail.includes("\uFFFD"), false);

    const stopped = await client.callTool({
      name: "stop_terminal_job",
      arguments: { conversationId, jobId },
    });
    assert.ok(!stopped.isError);
  } finally {
    await transport.close();
    await stopProcess(bridge);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("ConPTY mode renders native in-place progress bars without line-by-line spam and keeps MCP stdout clean", async () => {
  const testRoot = join(tmpdir(), `agy-ext-bridge-conpty-${randomUUID()}`);
  const stateRoot = join(testRoot, "state");
  const pairingFile = join(testRoot, "pairing-code.json");
  const workDir = join(testRoot, "work");
  await mkdir(workDir, { recursive: true });

  const env = {
    ...process.env,
    ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT: stateRoot,
    ANTIGRAVITY_TERMINAL_BRIDGE_PAIRING_FILE: pairingFile,
  };
  const conversationId = randomUUID();
  const { client, transport } = await createMcpClient(env);
  let bridge = null;

  try {
    bridge = startProcess(
      process.execPath,
      [bridgeScript, "--pty", "--pairing-file", pairingFile],
      env,
      workDir,
    );
    await waitForOutput(
      bridge,
      /Pairing code:\s+([0-9A-F]{4}(?:-[0-9A-F]{4}){5})/,
    );

    const paired = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId },
    });
    assert.ok(!paired.isError);
    assert.equal(paired.structuredContent.ptySupported, true);
    assert.equal(paired.structuredContent.ptyDefault, true);

    // 1. Run a script that checks IsOutputRedirected=False and uses SetCursorPosition (like DISM)
    const batch = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        commands: [
          'Write-Output "TTY_REDIRECTED=$([Console]::IsOutputRedirected)"',
          '$top = [Console]::CursorTop; foreach ($p in @(20, 60, 100)) { [Console]::SetCursorPosition(0, $top); [Console]::Write("[==== $p.0%    ]"); Start-Sleep -Milliseconds 50 }; [Console]::WriteLine(""); Write-Output "进度完成_无乱码"',
        ],
      },
    });
    assert.ok(!batch.isError, `ConPTY batch failed: ${JSON.stringify(batch)}`);
    assert.equal(batch.structuredContent.pty, true);
    assert.match(batch.structuredContent.stdout, /TTY_REDIRECTED=False/);
    assert.match(batch.structuredContent.stdout, /\[==== 100\.0%    \]/);
    assert.match(batch.structuredContent.stdout, /进度完成_无乱码/);
    // Intermediate progress frames must be collapsed in MCP stdout
    assert.equal(batch.structuredContent.stdout.includes("20.0%"), false);
    assert.equal(batch.structuredContent.stdout.includes("60.0%"), false);

    // External terminal stream must receive in-place CR redraws without clearing the screen
    const termOut = bridge.output();
    assert.equal(termOut.includes("\x1b[2J"), false, "ConPTY must not clear external terminal");
    assert.match(
      termOut,
      /\[==== 20\.0%    \]\r\[==== 60\.0%    \]\r\[==== 100\.0%    \]\r\n/,
    );
  } finally {
    await transport.close();
    await stopProcess(bridge);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("run_command_batch enforces 50s timeout cap, promotes timed-out batches to managed jobs without locking batchBusy, and supports killOnTimeout", async () => {
  const testRoot = join(tmpdir(), `agy-ext-bridge-timeout-${randomUUID()}`);
  const stateRoot = join(testRoot, "state");
  const pairingFile = join(testRoot, "pairing-code.json");
  const workDir = join(testRoot, "work");
  await mkdir(workDir, { recursive: true });

  const slowScript = join(workDir, "slow-phase.mjs");
  await writeFile(
    slowScript,
    [
      'console.log("START_PHASE_1");',
      'setTimeout(() => {',
      '  console.log("FINISH_PHASE_2");',
      '  process.exit(0);',
      '}, 2200);',
      "",
    ].join("\n"),
    "utf8",
  );

  const env = {
    ...process.env,
    ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT: stateRoot,
    ANTIGRAVITY_TERMINAL_BRIDGE_PAIRING_FILE: pairingFile,
  };
  const conversationId = randomUUID();
  const { client, transport } = await createMcpClient(env);
  let bridge = null;

  try {
    bridge = startProcess(
      process.execPath,
      [bridgeScript, "--pairing-file", pairingFile],
      env,
      workDir,
    );
    await waitForOutput(
      bridge,
      /Pairing code:\s+([0-9A-F]{4}(?:-[0-9A-F]{4}){5})/,
    );

    const paired = await client.callTool({
      name: "pair_external_terminal",
      arguments: { conversationId },
    });
    assert.ok(!paired.isError);

    // 1. Timeout > 50000 ms must be rejected by MCP input schema
    let rejectedBySchema = false;
    try {
      const tooLarge = await client.callTool({
        name: "run_command_batch",
        arguments: {
          conversationId,
          commands: ['Write-Output "should-not-run"'],
          timeoutMs: 120000,
        },
      });
      if (tooLarge.isError) {
        rejectedBySchema = true;
      } else {
        assert.fail(`Expected schema rejection for timeoutMs=120000, got: ${JSON.stringify(tooLarge)}`);
      }
    } catch {
      rejectedBySchema = true;
    }
    assert.equal(rejectedBySchema, true);

    // 2. Default timeout behavior (killOnTimeout=false): promotes to managed job and releases batchBusy
    const promoted = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        commands: [`node "${slowScript}"`],
        timeoutMs: 1100,
      },
    });
    assert.ok(!promoted.isError, `expected graceful promotion, got: ${JSON.stringify(promoted)}`);
    assert.equal(promoted.structuredContent.timedOut, true);
    assert.equal(promoted.structuredContent.killed, false);
    assert.equal(promoted.structuredContent.promotedToJob, true);
    assert.equal(promoted.structuredContent.status, "running");
    const promotedJobId = promoted.structuredContent.jobId;
    assert.ok(promotedJobId);

    // Immediately verify batchBusy is released and a new short batch can run without waiting
    const statusMid = await client.callTool({
      name: "bridge_status",
      arguments: { conversationId },
    });
    assert.ok(!statusMid.isError);
    assert.equal(statusMid.structuredContent.batchBusy, false);
    assert.equal(statusMid.structuredContent.activeBatch, null);
    assert.equal(statusMid.structuredContent.runningJobs, 1);

    const shortBatch = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        commands: ['Write-Output "NOT_BLOCKED_BY_BUSY"'],
      },
    });
    assert.ok(!shortBatch.isError);
    assert.match(shortBatch.structuredContent.stdout, /NOT_BLOCKED_BY_BUSY/);

    // Verify promoted job finishes cleanly and captures subsequent output
    let finalJob = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      finalJob = await client.callTool({
        name: "get_terminal_job_output",
        arguments: { conversationId, jobId: promotedJobId },
      });
      if (finalJob.structuredContent.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(!finalJob.isError);
    assert.equal(finalJob.structuredContent.status, "completed");
    assert.equal(finalJob.structuredContent.exitCode, 0);
    assert.equal(finalJob.structuredContent.promotedFromBatch, true);
    assert.match(finalJob.structuredContent.stdoutTail, /START_PHASE_1/);
    assert.match(finalJob.structuredContent.stdoutTail, /FINISH_PHASE_2/);

    // 3. Explicit killOnTimeout=true terminates the process tree instead of promoting
    const killedResp = await client.callTool({
      name: "run_command_batch",
      arguments: {
        conversationId,
        commands: ["Start-Sleep -Seconds 30"],
        timeoutMs: 1100,
        killOnTimeout: true,
      },
    });
    assert.equal(killedResp.isError, true);
    assert.equal(killedResp.structuredContent.timedOut, true);
    assert.equal(killedResp.structuredContent.killed, true);
    assert.equal(killedResp.structuredContent.promotedToJob, false);

    const statusAfterKill = await client.callTool({
      name: "bridge_status",
      arguments: { conversationId },
    });
    assert.equal(statusAfterKill.structuredContent.batchBusy, false);
    assert.equal(statusAfterKill.structuredContent.runningJobs, 0);
  } finally {
    await transport.close();
    await stopProcess(bridge);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
