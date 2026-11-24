# Antigravity External Terminal Bridge

An Antigravity native plugin and MCP server that lets Antigravity safely launch (including **Administrator** terminals via standard Windows UAC), pair, and operate external Windows Terminals over authenticated loopback TCP (`127.0.0.1`).

让 Antigravity 安全、可控地拉起、配对并操作你指定的外部 Windows Terminal（包括通过标准 Windows UAC 授权的**管理员权限终端**）。

---

## Key Features / 核心特性

- **Cross-Privilege Loopback Transport（跨权限本地回环通信）**：
  - External bridge binds strictly to `127.0.0.1:<random_port>` (never exposed to LAN/Internet), avoiding Windows Named Pipe Mandatory Integrity Level barriers between a standard Antigravity process and an Administrator external terminal.
- **Standard Windows UAC Elevation（标准 Windows UAC 提权，无任何绕过）**：
  - `launch_external_terminal(elevated: true)` invokes standard Windows `RunAs` to open a visible elevated Windows Terminal window (`wt.exe`, with fallback to `pwsh.exe`/`powershell.exe`).
  - Approval stays strictly with the user on the Windows UAC prompt; declining returns `uac-cancelled-by-user` immediately.
- **One-Time Pairing + HMAC-SHA256 Authentication（一次性配对 + HMAC 双向鉴权）**：
  - Generates a 24-hex-char one-time pairing code (10-minute TTL) and verifies every pairing and execution request with a local 32-byte key (`%LOCALAPPDATA%\AntigravityExternalTerminalBridge\identity.key`).
  - Keys and auth proofs stay strictly inside the MCP server and bridge processes — never exposed to model context.
  - Per-conversation isolation (`conversationId`) with multi-terminal aliases (`targetName`, e.g. `default`, `admin`).
- **Native Windows ConPTY In-Place Progress Bars（原生 ConPTY 进度条原地刷新）**：
  - Bundled C# source (`scripts/conpty-runner.cs`) compiles via built-in Windows `.NET Framework csc.exe` (zero external dependencies) to provide a real TTY (`IsOutputRedirected = False`) so `DISM`, `sfc`, `winget`, `pip`, and PowerShell `Write-Progress` update progress bars in-place instead of spamming line-by-line.
  - Dual-stream processor (`scripts/conpty-processor.mjs`) relativizes ConPTY cursor jumps and strips screen clears / title hijacks for the user's external terminal while returning clean, ANSI-stripped, CR-folded text to MCP.
- **Adaptive UTF-8 / GB18030 Decoding（自适应 UTF-8 / GB18030 防乱码）**：
  - Line- and multi-byte-boundary-aware stream decoder (`scripts/stream-decoder.mjs`) decodes strict UTF-8 first and falls back to `gb18030` (CP936/GBK) when native Windows CLI tools emit system-codepage bytes, preventing mojibake and cross-chunk character splitting.
- **Sync Timeout Protection & Auto-Promote to Managed Job（防 MCP 超时挂死与自动转后台作业）**：
  - `run_command_batch` defaults to `45000 ms` (capped at `50000 ms`) to stay safely below MCP's ~60s synchronous timeout.
  - On timeout (or unexpected client disconnect), still-running batches are automatically promoted to a managed background job (`promotedToJob: true`, returning `jobId` and immediately releasing `batchBusy`) instead of killing sensitive system operations or locking the terminal.
- **Persistent Working Directory & Multi-Shell Support**：
  - Persists `cd` / `Set-Location` changes across batches; supports `powershell`, `pwsh`, and `cmd`.

---

## Requirements / 环境要求

- Windows 10 (1809+) or Windows 11
- Node.js 20+
- Windows Terminal (`wt.exe`, optional — recommended for elevated and standard windows)
- Windows built-in `.NET Framework 4.x` (`csc.exe`, preinstalled on Windows 10/11 for compiling `conpty-runner.exe`)

---

## Quick Install / 一键安装

Clone this repository and run `install.ps1`:

```powershell
git clone https://github.com/czhovo/antigravity-external-terminal-bridge.git
cd antigravity-external-terminal-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` automatically:
1. Installs the plugin to `%USERPROFILE%\.gemini\config\plugins\external-terminal-bridge`
2. Generates `mcp_config.json` with your local absolute path to `scripts\mcp-server.mjs`
3. Compiles `scripts\conpty-runner.exe` using Windows built-in `csc.exe`
4. Installs runtime dependencies (`@modelcontextprotocol/sdk`, `zod`) via `npm install --omit=dev`

After installation, enable/refresh **External Terminal Bridge** in Antigravity's Customizations / MCP Servers panel.

---

## MCP Tools (10) / 工具一览

| Tool | Purpose |
| :--- | :--- |
| `launch_external_terminal` | Launch a visible external Windows Terminal (`elevated: true` triggers standard Windows UAC) and auto-pair once approved. Reuses an already-online terminal by default. |
| `pair_external_terminal` | Pair with an external terminal you started manually (reads Desktop `pairing-code.json` automatically). |
| `bridge_status` | Check connectivity, `elevated`, `inWindowsTerminal`, `cwd`, `batchBusy`, `activeBatch`, and active jobs. |
| `run_command_batch` | Execute 1–50 **short commands (`< 30s`)** sequentially (`timeoutMs` default `45000`, max `50000`; auto-promotes to a managed job on timeout unless `killOnTimeout: true`). |
| `start_long_running_command` | Start slow (`>= 30s`), uncertain-duration (`DISM`, `sfc`, installers, builds, tests), persistent, or interactive processes and return a `jobId`. |
| `list_terminal_jobs` | List managed jobs in the paired external terminal. |
| `get_terminal_job_output` | Inspect job status, exit code, and latest `stdoutTail` / `stderrTail`. |
| `send_terminal_job_input` | Send text to a running job's `stdin`. |
| `stop_terminal_job` | Terminate a job and its entire child process tree (`taskkill /T /F`). |
| `disconnect_terminal` | Unbind and optionally shut down or reopen the bridge with a fresh pairing code. |

---

## Manual Launch Commands / 手动启动备用命令

- **Start bridge in an existing external terminal (standard or already-Administrator)**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.gemini\config\plugins\external-terminal-bridge\scripts\start-external-bridge.ps1"
  ```
- **Trigger Windows UAC to open a new Administrator external terminal**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.gemini\config\plugins\external-terminal-bridge\scripts\start-admin-bridge.ps1"
  ```

---

## Development & Testing / 开发与测试

```powershell
npm install
npm run build:conpty
npm test
```

All tests run in isolated temporary state directories and never touch live bindings or active external terminals.

---

## License

[MIT](./LICENSE)
