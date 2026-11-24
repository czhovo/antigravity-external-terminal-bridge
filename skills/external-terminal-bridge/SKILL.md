---
name: external-terminal-bridge
description: Launch (with standard Windows UAC for Administrator terminals), pair, and operate a user-selected external Windows Terminal via the external-terminal-bridge MCP server. Use when the user asks Antigravity to open, connect to, run commands in, or manage long-running processes inside an external terminal or an Administrator terminal.
---

# External Terminal Bridge Workflow

Use the `external-terminal-bridge` MCP server to launch, pair, and operate external Windows Terminals (including Administrator elevated terminals) over authenticated `127.0.0.1` loopback TCP.

## Key Principles

1. **Always pass `conversationId`**: Use the exact `Conversation ID` UUID from `<user_information>` on every tool call so bindings stay strictly isolated per conversation.
2. **Proactive UAC launch when Administrator access is needed**:
   - When an Administrator terminal is needed and none is currently paired, call `launch_external_terminal` with `{ conversationId, elevated: true, targetName? }`.
   - Briefly inform the user that a standard Windows UAC prompt will appear for them to approve.
   - Once the user clicks **Yes**, `launch_external_terminal` automatically waits for the elevated external terminal bridge to start and pairs it.
   - If the user declines UAC (`uac-cancelled-by-user`), stop immediately and report the cancellation — never retry silently or attempt to bypass UAC.
   - If `launch_external_terminal` reports that the host environment blocks `RunAs` (`launch-failed`), fall back to giving the user the manual command below.
3. **Connecting a user-started terminal without copying codes**:
   - If the user already started an external bridge manually, call `pair_external_terminal` directly (omitting `pairingCode`); it automatically reads Desktop `pairing-code.json`.
4. **Sync vs. Async Command Routing Redline (CRITICAL — Avoid MCP ~60s Timeout)**:
   - Antigravity's MCP client enforces a ~60s synchronous tool call timeout.
   - **Short commands (`< 30s` total)**: use `run_command_batch` (defaults to `timeoutMs: 45000`, capped at `50000`). If a synchronous batch unexpectedly hits `timeoutMs`, it automatically promotes the still-running process to a managed background job (`promotedToJob: true`, returning `jobId` and releasing `batchBusy`) rather than killing the process or hanging the terminal.
   - **Slow, long-running, or uncertain-duration commands (`>= 30s`)**: ALWAYS use `start_long_running_command` + `get_terminal_job_output` — NEVER put them in `run_command_batch`. This includes `DISM` (`/RestoreHealth`, `/ScanHealth`, `/StartComponentCleanup`), `sfc /scannow`, `chkdsk`, software/driver installers (`winget`, `msiexec`, `choco`, `pip`/`npm` large installs), large C++/Rust/Docker builds, long test suites, dev servers, watchers, and log followers.
   - **Monitoring async jobs**: Use `schedule` (one-shot timer, e.g. 20–60s depending on task) to check progress with `get_terminal_job_output` instead of calling `get_terminal_job_output` in a tight polling loop.
   - **Recovering if a previous sync batch disconnected**: Call `bridge_status` and `list_terminal_jobs`; any promoted batch appears as a managed job (`promotedFromBatch: true`) that you can inspect via `get_terminal_job_output` or terminate via `stop_terminal_job`.
5. **Administrator safety guardrail**:
   - Whenever `elevated: true` is reported, clearly acknowledge Administrator privileges and confirm destructive or system-wide changes before execution.
6. **Never fall back to UI automation**: Do not use SendKeys, mouse clicks, or keyboard simulation.

## Tool Reference (MCP Server: `external-terminal-bridge_external-terminal-bridge`)

Every tool accepts `conversationId` (**required**, current Antigravity Conversation ID UUID from `<user_information>`) and optional `targetName` (default `"default"`, e.g. `"admin"`).

- `launch_external_terminal`:
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `elevated` (boolean, default `false`; `true` triggers Windows UAC), `cwd` (string, default user home directory), `shell` (`"powershell" | "pwsh" | "cmd"`, default auto-detect), `label` (string, optional), `useWindowsTerminal` (boolean, default `true`), `keepOpenOnExit` (boolean, default `false`), `autoPair` (boolean, default `true`), `reuseIfOnline` (boolean, default `true`), `waitTimeoutMs` (integer 5000–120000, default `45000`).
  - Returns: `{ launched, reused, paired, online, elevated, inWindowsTerminal, usedWindowsTerminal?, sessionId, pid, cwd, defaultShell, targetName, ... }` (or `reason: "uac-cancelled-by-user"` if the user declines UAC).
- `pair_external_terminal`:
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `pairingCode` (string, optional manual fallback), `pairingFile` (string, default Desktop `pairing-code.json`).
- `bridge_status`:
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `listAllForConversation` (boolean, default `false`).
  - Note: returns `batchBusy`, `activeBatch` (if any), `runningJobs`, `totalJobs`, `ptySupported`, `ptyDefault`. Pass `listAllForConversation: true` to safely list all bound targets without erroring when none exist.
- `run_command_batch` (**short commands `< 30s` only**):
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `commands` (required `string[]`, 1–50 items), `cwd` (string, optional one-shot override), `shell` (`"powershell" | "pwsh" | "cmd"`, optional), `timeoutMs` (integer 1000–50000, default `45000`), `killOnTimeout` (boolean, default `false`; when `false`, timeout promotes the process to a managed job and returns `jobId`), `persistCwd` (boolean, default `true`), `pty` (boolean, default `true` in interactive external terminals so native progress bars update in-place via Windows ConPTY).
- `start_long_running_command` (**required for commands `>= 30s` or uncertain duration**):
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `command` (required string), `cwd` (string, optional), `shell` (`"powershell" | "pwsh" | "cmd"`, optional), `startupGraceMs` (integer 0–5000, default `350`), `pty` (boolean, default `true` in interactive external terminals).
- `list_terminal_jobs`:
  - Parameters: `conversationId` (required), `targetName` (default `"default"`).
- `get_terminal_job_output`:
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `jobId` (required UUID).
- `send_terminal_job_input`:
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `jobId` (required UUID), `input` (required string), `appendNewline` (boolean, default `true`).
- `stop_terminal_job`:
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `jobId` (required UUID).
- `disconnect_terminal`:
  - Parameters: `conversationId` (required), `targetName` (default `"default"`), `shutdown` (boolean, default `false`; set `true` to close the external terminal bridge), `reopenForPairing` (boolean, default `true` when `shutdown` is `false`).

## Manual Launch Commands (Fallback)

- **Existing terminal (standard or already-Administrator)**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.gemini\config\plugins\external-terminal-bridge\scripts\start-external-bridge.ps1"
  ```
- **Open a new Administrator terminal (triggers Windows UAC)**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.gemini\config\plugins\external-terminal-bridge\scripts\start-admin-bridge.ps1"
  ```
