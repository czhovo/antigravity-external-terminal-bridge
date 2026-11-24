const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });
const gb18030Decoder = new TextDecoder("gb18030");

/**
 * Decode a complete byte segment using strict UTF-8 first, falling back to GB18030
 * when invalid UTF-8 bytes are encountered (e.g., native Windows tools like DISM/sfc/ipconfig
 * emitting CP936/GBK bytes when stdout/stderr are redirected to pipes).
 */
export function decodeAdaptiveBytes(bytes) {
  if (!bytes || bytes.length === 0) return "";
  try {
    return utf8FatalDecoder.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      return gb18030Decoder.decode(bytes);
    }
    throw error;
  }
}

/**
 * Find the largest prefix length that does not split a multi-byte UTF-8 or GB18030 character.
 */
function findSafeSplitIndex(buffer) {
  const len = buffer.length;
  if (len === 0) return 0;

  // 1. Check if buffer (minus 0..3 trailing incomplete UTF-8 bytes) is valid UTF-8.
  const maxTrim = Math.min(3, len);
  for (let trim = 0; trim <= maxTrim; trim += 1) {
    const candidateLen = len - trim;
    if (candidateLen === 0) break;
    try {
      utf8FatalDecoder.decode(buffer.subarray(0, candidateLen));
      if (trim === 0) return len;
      // Only hold trailing bytes if they could plausibly start an incomplete UTF-8 sequence.
      const lead = buffer[candidateLen];
      if ((lead & 0xc0) === 0xc0) {
        return candidateLen;
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }

  // 2. Otherwise walk GB18030 character boundaries so we never split a 2-byte or 4-byte character.
  let offset = 0;
  while (offset < len) {
    const b0 = buffer[offset];
    if (b0 <= 0x7f) {
      offset += 1;
      continue;
    }
    if (b0 >= 0x81 && b0 <= 0xfe) {
      if (offset + 1 >= len) break;
      const b1 = buffer[offset + 1];
      if (b1 >= 0x40 && b1 <= 0xfe && b1 !== 0x7f) {
        offset += 2;
        continue;
      }
      if (b1 >= 0x30 && b1 <= 0x39) {
        if (offset + 3 >= len) break;
        const b2 = buffer[offset + 2];
        const b3 = buffer[offset + 3];
        if (b2 >= 0x81 && b2 <= 0xfe && b3 >= 0x30 && b3 <= 0x39) {
          offset += 4;
          continue;
        }
      }
    }
    // Single invalid/unrecognized byte; advance by 1 so progress is guaranteed.
    offset += 1;
  }
  return offset;
}

/**
 * Create a line- and boundary-aware adaptive stream decoder.
 * - Buffers incoming bytes until LF (0x0A) or CR (0x0D) boundaries (neither byte can appear
 *   inside a UTF-8 or GB18030 multi-byte sequence), decoding each line/segment independently
 *   so mixed UTF-8 + GBK outputs render cleanly without cross-chunk character corruption.
 * - Enforces maxBufferBytes using multi-byte-safe boundary splitting for huge newline-free output.
 * - Supports optional idleFlushMs for interactive prompts without trailing newlines.
 */
export function createAdaptiveStreamDecoder(
  onText,
  { maxBufferBytes = 8192, idleFlushMs = 0 } = {},
) {
  let pending = Buffer.alloc(0);
  let idleTimer = null;

  function clearIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function emitSegment(segment) {
    if (segment.length === 0) return;
    const text = decodeAdaptiveBytes(segment);
    if (text.length > 0) {
      onText(text);
    }
  }

  function flushSafePrefix() {
    if (pending.length === 0) return;
    const splitIndex = findSafeSplitIndex(pending);
    if (splitIndex > 0) {
      const ready = pending.subarray(0, splitIndex);
      pending = pending.subarray(splitIndex);
      emitSegment(ready);
    }
  }

  function scheduleIdleFlush() {
    clearIdleTimer();
    if (idleFlushMs > 0 && pending.length > 0) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        flushSafePrefix();
      }, idleFlushMs);
      if (typeof idleTimer.unref === "function") {
        idleTimer.unref();
      }
    }
  }

  function push(chunk) {
    if (!chunk || chunk.length === 0) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length === 0) return;

    clearIdleTimer();
    let buffer = pending.length > 0 ? Buffer.concat([pending, incoming]) : incoming;
    let segmentStart = 0;

    for (let i = 0; i < buffer.length; i += 1) {
      const byte = buffer[i];
      if (byte === 0x0a) {
        emitSegment(buffer.subarray(segmentStart, i + 1));
        segmentStart = i + 1;
      } else if (byte === 0x0d) {
        if (i + 1 < buffer.length && buffer[i + 1] === 0x0a) {
          emitSegment(buffer.subarray(segmentStart, i + 2));
          i += 1;
          segmentStart = i + 1;
        } else {
          emitSegment(buffer.subarray(segmentStart, i + 1));
          segmentStart = i + 1;
        }
      }
    }

    pending = segmentStart < buffer.length
      ? Buffer.from(buffer.subarray(segmentStart))
      : Buffer.alloc(0);

    while (pending.length >= maxBufferBytes) {
      const splitIndex = findSafeSplitIndex(pending);
      if (splitIndex <= 0) {
        // Fallback if buffer starts with malformed bytes exceeding limit.
        emitSegment(pending);
        pending = Buffer.alloc(0);
        break;
      }
      const ready = pending.subarray(0, splitIndex);
      pending = Buffer.from(pending.subarray(splitIndex));
      emitSegment(ready);
    }

    scheduleIdleFlush();
  }

  function flush() {
    clearIdleTimer();
    if (pending.length === 0) return;
    const remaining = pending;
    pending = Buffer.alloc(0);
    emitSegment(remaining);
  }

  return { push, flush };
}
