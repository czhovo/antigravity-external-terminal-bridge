import assert from "node:assert/strict";
import test from "node:test";
import { createConPtyOutputProcessor } from "../scripts/conpty-processor.mjs";

function runProcessor(chunks, options = {}) {
  let terminal = "";
  let clean = "";
  const proc = createConPtyOutputProcessor({
    cols: 100,
    rows: 25,
    ...options,
    onTerminal: (t) => {
      terminal += t;
    },
    onCleanText: (t) => {
      clean += t;
    },
  });
  for (const chunk of chunks) {
    proc.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
  }
  proc.flush();
  return { terminal, clean };
}

test("ConPTY processor strips destructive clears/titles and converts absolute row jumps to relative newlines", () => {
  // Real DISM ConPTY VT output pattern observed on Windows 11
  const raw =
    "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m" +
    "\x1b[2;1H错误: 740" +
    "\x1b[4;1H\x1b]0;C:\\WINDOWS\\system32\\dism.exe\x07\x1b[?25h\x1b[?9001l\x1b[?1004l" +
    "需要提升权限才能运行 DISM。\r\n";

  const { terminal, clean } = runProcessor([raw]);

  assert.equal(terminal.includes("\x1b[2J"), false, "must not clear external terminal screen");
  assert.equal(terminal.includes("\x1b]0;"), false, "must not hijack external terminal title");
  assert.equal(terminal.includes("\x1b[?9001"), false, "must not emit Win32 input mode");
  assert.equal(terminal.includes("\x1b[2;1H"), false, "must not jump to absolute row 2");
  assert.match(terminal, /\r\n错误: 740\r\n\r\n需要提升权限才能运行 DISM。\r\n/);
  assert.equal(clean, "\n错误: 740\n\n需要提升权限才能运行 DISM。\n");
});

test("ConPTY processor keeps in-place CR progress updates for external terminal and folds them for MCP clean text", () => {
  const raw =
    "\x1b[?25l\x1b[2J\x1b[H" +
    "\x1b[36m开始扫描...\x1b[0m\r\n" +
    "\x1b[33m[===  10.0% ]\x1b[0m\r" +
    "\x1b[33m[====== 50.0% ]\x1b[0m\r" +
    "\x1b[32m[========== 100.0% ]\x1b[0m\x1b[K\r\n" +
    "未检测到组件存储损坏。\r\n";

  const { terminal, clean } = runProcessor([raw]);

  // External terminal keeps colors + \r in-place redraws (no extra \n between progress frames)
  assert.match(
    terminal,
    /\x1b\[33m\[===  10\.0% \]\x1b\[0m\r\x1b\[33m\[====== 50\.0% \]\x1b\[0m\r\x1b\[32m\[========== 100\.0% \]\x1b\[0m\x1b\[K\r\n/,
  );

  // MCP clean text strips ANSI colors and collapses overwritten progress frames to the final frame
  assert.equal(
    clean,
    "开始扫描...\n[========== 100.0% ]\n未检测到组件存储损坏。\n",
  );
  assert.equal(clean.includes("10.0%"), false);
  assert.equal(clean.includes("50.0%"), false);
});

test("ConPTY processor converts same-row absolute CUP (\\x1b[row;1H) into in-place \\r and handles split escape chunks", () => {
  const full =
    "\x1b[2J\x1b[H" +
    "第一行\r\n" +
    "[=== 20%   ]\x1b[2;1H[====== 60%]\x1b[2;1H[===== 100%]\r\n" +
    "完成\r\n";

  // Split every 2 bytes across ESC / CSI / UTF-8 boundaries
  const buf = Buffer.from(full, "utf8");
  const chunks = [];
  for (let i = 0; i < buf.length; i += 2) {
    chunks.push(buf.subarray(i, i + 2));
  }

  const { terminal, clean } = runProcessor(chunks);

  assert.equal(terminal.includes("\x1b[2;1H"), false);
  assert.match(terminal, /第一行\r\n\[=== 20%   \]\r\[====== 60%\]\r\[===== 100%\]\r\n完成\r\n/);
  assert.equal(clean, "第一行\n[===== 100%]\n完成\n");
});
