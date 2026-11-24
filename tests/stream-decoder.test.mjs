import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdaptiveStreamDecoder,
  decodeAdaptiveBytes,
} from "../scripts/stream-decoder.mjs";

// Exact GBK/CP936 bytes for "未检测到组件存储损坏。"
const GBK_DISM_OK = Buffer.from([
  0xce, 0xb4, 0xbc, 0xec, 0xb2, 0xe2, 0xb5, 0xbd, 0xd7, 0xe9, 0xbc, 0xfe,
  0xb4, 0xe6, 0xb4, 0xa2, 0xcb, 0xf0, 0xbb, 0xb5, 0xa1, 0xa3,
]);
const TEXT_DISM_OK = "未检测到组件存储损坏。";

// Exact GBK/CP936 bytes for "操作成功完成。"
const GBK_OP_DONE = Buffer.from([
  0xb2, 0xd9, 0xd7, 0xf7, 0xb3, 0xc9, 0xb9, 0xa6, 0xcd, 0xea, 0xb3, 0xc9,
  0xa1, 0xa3,
]);
const TEXT_OP_DONE = "操作成功完成。";

// Exact GBK/CP936 bytes for "请输入确认: "
const GBK_PROMPT = Buffer.from([
  0xc7, 0xeb, 0xca, 0xe4, 0xc8, 0xeb, 0xc8, 0xb7, 0xc8, 0xcf, 0x3a, 0x20,
]);
const TEXT_PROMPT = "请输入确认: ";

// Exact GB18030 4-byte character U+20000 ("𠀀"): 95 32 82 36
const GB18030_FOUR_BYTE = Buffer.from([0x95, 0x32, 0x82, 0x36]);
const TEXT_FOUR_BYTE = "\u{20000}";

function feedChunks(chunks, options) {
  let result = "";
  const decoder = createAdaptiveStreamDecoder((text) => {
    result += text;
  }, options);
  for (const chunk of chunks) {
    decoder.push(chunk);
  }
  decoder.flush();
  return result;
}

function splitBySize(buffer, size) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += size) {
    chunks.push(buffer.subarray(i, i + size));
  }
  return chunks;
}

test("decodeAdaptiveBytes decodes pure UTF-8 (including Chinese and 4-byte emoji)", () => {
  const input = "PowerShell UTF-8 输出测试 🚀 成功\r\n第二行中文";
  const decoded = decodeAdaptiveBytes(Buffer.from(input, "utf8"));
  assert.equal(decoded, input);
});

test("decodeAdaptiveBytes falls back to GB18030 for GBK/CP936 bytes such as DISM output", () => {
  const decoded = decodeAdaptiveBytes(GBK_DISM_OK);
  assert.equal(decoded, TEXT_DISM_OK);
  assert.equal(decoded.includes("\uFFFD"), false);
});

test("stream decoder handles mixed UTF-8 and GBK lines plus CR progress bars", () => {
  const combined = Buffer.concat([
    Buffer.from("[antigravity-bridge 1/1] DISM /Online /Cleanup-Image /CheckHealth\r\n", "utf8"),
    Buffer.from("UTF-8 标题行：开始检查组件存储\r\n", "utf8"),
    Buffer.from("[==== 20.0% ]\r[==== 100.0% ]\r\n", "ascii"),
    GBK_DISM_OK,
    Buffer.from("\r\n", "ascii"),
    GBK_OP_DONE,
    Buffer.from("\r\n", "ascii"),
    Buffer.from("UTF-8 结尾行：全部检查完成\r\n", "utf8"),
  ]);

  const expected =
    "[antigravity-bridge 1/1] DISM /Online /Cleanup-Image /CheckHealth\r\n" +
    "UTF-8 标题行：开始检查组件存储\r\n" +
    "[==== 20.0% ]\r[==== 100.0% ]\r\n" +
    `${TEXT_DISM_OK}\r\n` +
    `${TEXT_OP_DONE}\r\n` +
    "UTF-8 结尾行：全部检查完成\r\n";

  // Single chunk
  assert.equal(feedChunks([combined]), expected);
  // 1-byte chunks (worst-case cross-chunk boundary for every multi-byte char)
  assert.equal(feedChunks(splitBySize(combined, 1)), expected);
  // 3-byte odd chunks
  assert.equal(feedChunks(splitBySize(combined, 3)), expected);
});

test("stream decoder preserves multi-byte UTF-8 and GB18030 characters across maxBufferBytes splits without newlines", () => {
  const utf8Long = "无换行中文测试数据🚀".repeat(5);
  const utf8Buf = Buffer.from(utf8Long, "utf8");
  assert.equal(
    feedChunks(splitBySize(utf8Buf, 2), { maxBufferBytes: 10 }),
    utf8Long,
  );

  const gbkLong = Buffer.concat([
    GBK_DISM_OK,
    GBK_OP_DONE,
    GB18030_FOUR_BYTE,
    GBK_DISM_OK,
  ]);
  const expectedGbk = `${TEXT_DISM_OK}${TEXT_OP_DONE}${TEXT_FOUR_BYTE}${TEXT_DISM_OK}`;
  assert.equal(
    feedChunks(splitBySize(gbkLong, 1), { maxBufferBytes: 7 }),
    expectedGbk,
  );
  assert.equal(
    feedChunks(splitBySize(gbkLong, 3), { maxBufferBytes: 9 }),
    expectedGbk,
  );
});

test("stream decoder idleFlushMs holds incomplete multi-byte tail until completed and flushes prompt cleanly", async () => {
  const emitted = [];
  const decoder = createAdaptiveStreamDecoder(
    (text) => emitted.push(text),
    { idleFlushMs: 30 },
  );

  // Split right inside the 2nd GBK character ("输" = 0xca 0xe4): send first 3 bytes [0xc7, 0xeb, 0xca]
  decoder.push(GBK_PROMPT.subarray(0, 3));
  await new Promise((resolve) => setTimeout(resolve, 60));
  // First complete GBK char "请" may flush safely, while lone 0xca must NOT emit U+FFFD
  assert.equal(emitted.join("").includes("\uFFFD"), false);

  // Send the remaining bytes [0xe4, ..., 0x20]
  decoder.push(GBK_PROMPT.subarray(3));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(emitted.join(""), TEXT_PROMPT);
  assert.equal(emitted.join("").includes("\uFFFD"), false);

  decoder.flush();
  assert.equal(emitted.join(""), TEXT_PROMPT);
});
