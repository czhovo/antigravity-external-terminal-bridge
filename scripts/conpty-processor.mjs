import { createAdaptiveStreamDecoder } from "./stream-decoder.mjs";

/**
 * Process raw ConPTY output into two synchronized streams:
 * 1) `onTerminal(vtText)`: safe, relative VT output for the user's external Windows Terminal
 *    - Keeps SGR colors, line erases (\x1b[K), and in-place CR (\r) progress bar updates
 *    - Strips destructive full-screen clears (\x1b[2J), OSC title hijacks (\x1b]0;...\x07),
 *      Win32 input/focus modes (\x1b[?9001h / \x1b[?1004h), and cursor hide/show glitches
 *    - Converts ConPTY absolute cursor jumps (\x1b[row;colH) into relative line/column moves
 *      so prior scrollback in the user's external terminal is NEVER overwritten.
 * 2) `onCleanText(text)` (or `cleanText()`): ANSI-stripped, CR-collapsed readable text for MCP.
 */
export function createConPtyOutputProcessor({
  cols = 120,
  rows = 30,
  onTerminal,
  onCleanText,
  idleFlushMs = 0,
}) {
  let escBuffer = "";
  let virtualRow = 1;
  let virtualCol = 1;
  let hasEmittedContent = false;

  // Clean-text line accumulator for folding in-place \r progress frames before emitting to MCP
  let cleanLineBuf = "";
  let cleanCursorCol = 0;

  function emitTerminal(text) {
    if (text && onTerminal) onTerminal(text);
  }

  function emitClean(text) {
    if (text && onCleanText) onCleanText(text);
  }

  function commitCleanLine(newlineSuffix) {
    const out = `${cleanLineBuf}${newlineSuffix}`;
    cleanLineBuf = "";
    cleanCursorCol = 0;
    emitClean(out);
  }

  function writeCleanChar(ch) {
    if (cleanCursorCol >= cleanLineBuf.length) {
      if (cleanCursorCol > cleanLineBuf.length) {
        cleanLineBuf += " ".repeat(cleanCursorCol - cleanLineBuf.length);
      }
      cleanLineBuf += ch;
      cleanCursorCol = cleanLineBuf.length;
    } else {
      cleanLineBuf =
        cleanLineBuf.slice(0, cleanCursorCol) +
        ch +
        cleanLineBuf.slice(cleanCursorCol + 1);
      cleanCursorCol += 1;
    }
  }

  function eraseCleanToEndOfLine() {
    if (cleanCursorCol < cleanLineBuf.length) {
      cleanLineBuf = cleanLineBuf.slice(0, cleanCursorCol);
    }
  }

  function eraseCleanWholeLine() {
    cleanLineBuf = "";
    cleanCursorCol = 0;
  }

  function clampRow(r) {
    return Math.max(1, Math.min(rows, r));
  }

  function clampCol(c) {
    return Math.max(1, Math.min(cols, c));
  }

  function handleCsi(paramsRaw, finalChar) {
    // Strip private modes like ?9001h, ?1004h, ?25l, ?25h, ?1049h/l
    if (paramsRaw.startsWith("?")) {
      return;
    }

    const parts = paramsRaw === "" ? [] : paramsRaw.split(";");
    const num = (idx, fallback) => {
      const v = Number.parseInt(parts[idx] ?? "", 10);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };

    switch (finalChar) {
      case "m":
        // SGR colors / styling: pass through to external terminal, omit from clean text
        emitTerminal(`\x1b[${paramsRaw}m`);
        break;

      case "K": {
        // Erase in Line: safe and essential for progress bars that shrink in length
        const mode = Number.parseInt(parts[0] || "0", 10) || 0;
        emitTerminal(`\x1b[${paramsRaw}K`);
        if (mode === 0) eraseCleanToEndOfLine();
        else if (mode === 2) eraseCleanWholeLine();
        break;
      }

      case "J":
        // Suppress full-screen erase (\x1b[2J / \x1b[3J / \x1b[J) so external scrollback stays intact
        break;

      case "H":
      case "f": {
        // Absolute Cursor Position (CUP / HVP) -> convert to relative motion
        const targetRow = clampRow(num(0, 1));
        const targetCol = clampCol(num(1, 1));

        if (!hasEmittedContent && targetRow === 1 && targetCol === 1) {
          virtualRow = 1;
          virtualCol = 1;
          return;
        }

        const rowDelta = targetRow - virtualRow;
        if (rowDelta > 0) {
          emitTerminal("\r\n".repeat(rowDelta));
          if (targetCol > 1) emitTerminal(`\x1b[${targetCol - 1}C`);
          commitCleanLine("\n".repeat(rowDelta));
          cleanCursorCol = targetCol - 1;
        } else if (rowDelta < 0) {
          emitTerminal(`\x1b[${-rowDelta}A\r`);
          if (targetCol > 1) emitTerminal(`\x1b[${targetCol - 1}C`);
          // Keep clean text readable without mangling prior committed lines
          cleanCursorCol = targetCol - 1;
        } else {
          // Same row: in-place update (classic DISM / progress bar redraw)
          if (targetCol === 1) {
            emitTerminal("\r");
          } else if (targetCol > virtualCol) {
            emitTerminal(`\x1b[${targetCol - virtualCol}C`);
          } else if (targetCol < virtualCol) {
            emitTerminal(`\r\x1b[${targetCol - 1}C`);
          }
          cleanCursorCol = targetCol - 1;
        }

        virtualRow = targetRow;
        virtualCol = targetCol;
        hasEmittedContent = true;
        break;
      }

      case "G": {
        // Cursor Horizontal Absolute (1-based column)
        const targetCol = clampCol(num(0, 1));
        if (targetCol === 1) {
          emitTerminal("\r");
        } else if (targetCol > virtualCol) {
          emitTerminal(`\x1b[${targetCol - virtualCol}C`);
        } else if (targetCol < virtualCol) {
          emitTerminal(`\r\x1b[${targetCol - 1}C`);
        }
        virtualCol = targetCol;
        cleanCursorCol = targetCol - 1;
        break;
      }

      case "A": {
        const n = num(0, 1);
        const moved = Math.min(n, virtualRow - 1);
        if (moved > 0) {
          emitTerminal(`\x1b[${moved}A`);
          virtualRow -= moved;
        }
        break;
      }

      case "B": {
        const n = num(0, 1);
        emitTerminal("\r\n".repeat(n));
        virtualRow = clampRow(virtualRow + n);
        virtualCol = 1;
        commitCleanLine("\n".repeat(n));
        break;
      }

      case "C": {
        const n = num(0, 1);
        emitTerminal(`\x1b[${n}C`);
        virtualCol = clampCol(virtualCol + n);
        cleanCursorCol += n;
        break;
      }

      case "D": {
        const n = num(0, 1);
        const moved = Math.min(n, virtualCol - 1);
        if (moved > 0) {
          emitTerminal(`\x1b[${moved}D`);
          virtualCol -= moved;
          cleanCursorCol = Math.max(0, cleanCursorCol - moved);
        }
        break;
      }

      case "X": {
        // Erase Character (ECH)
        const n = num(0, 1);
        emitTerminal(`\x1b[${n}X`);
        break;
      }

      default:
        // Ignore other terminal queries/control sequences (DSR, scroll region, etc.)
        break;
    }
  }

  function processDecodedText(text) {
    const input = escBuffer ? `${escBuffer}${text}` : text;
    escBuffer = "";

    let i = 0;
    let plainRunStart = 0;

    const flushPlainRun = (endIdx) => {
      if (endIdx <= plainRunStart) return;
      const run = input.slice(plainRunStart, endIdx);
      emitTerminal(run);
      hasEmittedContent = true;
      for (const ch of run) {
        writeCleanChar(ch);
        virtualCol = Math.min(cols, virtualCol + 1);
      }
    };

    while (i < input.length) {
      const code = input.charCodeAt(i);

      if (code === 0x1b) {
        flushPlainRun(i);

        // Incomplete ESC at end of chunk
        if (i + 1 >= input.length) {
          escBuffer = input.slice(i);
          return;
        }

        const next = input[i + 1];
        if (next === "[") {
          // CSI sequence: ESC [ <params 0x30-0x3F>* <interm 0x20-0x2F>* <final 0x40-0x7E>
          let j = i + 2;
          while (j < input.length) {
            const c = input.charCodeAt(j);
            if (c >= 0x40 && c <= 0x7e) break;
            j += 1;
          }
          if (j >= input.length) {
            // Incomplete CSI across chunk boundary
            if (input.length - i < 128) {
              escBuffer = input.slice(i);
              return;
            }
            i += 2;
            plainRunStart = i;
            continue;
          }
          const paramsRaw = input.slice(i + 2, j);
          const finalChar = input[j];
          handleCsi(paramsRaw, finalChar);
          i = j + 1;
          plainRunStart = i;
          continue;
        }

        if (next === "]") {
          // OSC sequence: ESC ] ... (BEL \x07 or ST \x1b\\)
          let j = i + 2;
          let foundEnd = -1;
          while (j < input.length) {
            if (input.charCodeAt(j) === 0x07) {
              foundEnd = j + 1;
              break;
            }
            if (
              input.charCodeAt(j) === 0x1b &&
              j + 1 < input.length &&
              input[j + 1] === "\\"
            ) {
              foundEnd = j + 2;
              break;
            }
            j += 1;
          }
          if (foundEnd === -1) {
            if (input.length - i < 512) {
              escBuffer = input.slice(i);
              return;
            }
            i += 2;
            plainRunStart = i;
            continue;
          }
          // Suppress OSC sequences (window title changes, etc.)
          i = foundEnd;
          plainRunStart = i;
          continue;
        }

        // Other 2-byte ESC sequence
        i += 2;
        plainRunStart = i;
        continue;
      }

      if (code === 0x0d) {
        // Carriage return (\r)
        flushPlainRun(i);
        emitTerminal("\r");
        virtualCol = 1;
        cleanCursorCol = 0;
        hasEmittedContent = true;
        i += 1;
        plainRunStart = i;
        continue;
      }

      if (code === 0x0a) {
        // Line feed (\n)
        flushPlainRun(i);
        emitTerminal("\n");
        virtualRow = clampRow(virtualRow + 1);
        virtualCol = 1;
        commitCleanLine("\n");
        hasEmittedContent = true;
        i += 1;
        plainRunStart = i;
        continue;
      }

      if (code === 0x08) {
        // Backspace (\b)
        flushPlainRun(i);
        emitTerminal("\b");
        virtualCol = Math.max(1, virtualCol - 1);
        cleanCursorCol = Math.max(0, cleanCursorCol - 1);
        i += 1;
        plainRunStart = i;
        continue;
      }

      i += 1;
    }

    flushPlainRun(input.length);
  }

  // Decode bytes with adaptive UTF-8/GB18030 first, using short idleFlushMs so real-time
  // progress updates and prompts stream immediately to the external terminal.
  const byteDecoder = createAdaptiveStreamDecoder(processDecodedText, {
    idleFlushMs: idleFlushMs > 0 ? idleFlushMs : 25,
  });

  return {
    push(chunk) {
      byteDecoder.push(chunk);
    },
    flush() {
      byteDecoder.flush();
      escBuffer = "";
      if (cleanLineBuf.length > 0) {
        commitCleanLine("");
      }
      // Always restore default SGR styling and visible cursor when a command finishes.
      emitTerminal("\x1b[0m\x1b[?25h");
    },
  };
}
