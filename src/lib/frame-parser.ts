/**
 * JSON-over-TCP frame parser.
 *
 * Pulled out of the client because it has no I/O dependencies and is the
 * trickiest piece of logic (string-aware, escape-aware brace matching).
 * Keeping it pure makes it easy to unit-test without socket mocking.
 */

const BYTE_BACKSLASH = 0x5c;
const BYTE_DQUOTE = 0x22;
const BYTE_LBRACE = 0x7b;
const BYTE_RBRACE = 0x7d;

/**
 * Returns the byte offset of the matching `}` for the `{` at `start`,
 * or `-1` if the buffer does not yet contain a complete object.
 *
 * Handles strings containing braces and JSON-escaped quotes correctly.
 *
 * @param buf
 * @param start
 */
export function findJsonObjectEnd(buf: Buffer, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === BYTE_BACKSLASH) {
        escape = true;
      } else if (c === BYTE_DQUOTE) {
        inString = false;
      }
      continue;
    }
    if (c === BYTE_DQUOTE) {
      inString = true;
      continue;
    }
    if (c === BYTE_LBRACE) {
      depth++;
    } else if (c === BYTE_RBRACE) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Stateful frame extractor. Feed it bytes as they arrive on the socket;
 * call {@link drain} to pull out every complete JSON object that has been
 * accumulated. Incomplete trailing bytes are kept for the next round.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Append more bytes from the wire.
   *
   * @param chunk
   */
  public feed(chunk: Buffer): void {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /**
   * Pulls every complete JSON object out of the internal buffer and parses it.
   * Malformed objects are skipped (and the offending slice returned via the
   * `onError` callback, if provided).
   *
   * @param onError
   */
  public drain<T = unknown>(onError?: (raw: string, err: Error) => void): T[] {
    const result: T[] = [];
    let cursor = 0;

    while (cursor < this.buffer.length) {
      // Skip anything before the next `{` (whitespace, stray \r\n, garbage).
      while (
        cursor < this.buffer.length &&
        this.buffer[cursor] !== BYTE_LBRACE
      ) {
        cursor++;
      }
      if (cursor >= this.buffer.length) {
        break;
      }

      const end = findJsonObjectEnd(this.buffer, cursor);
      if (end === -1) {
        break;
      } // incomplete — wait for more bytes

      const raw = this.buffer.subarray(cursor, end + 1).toString("ascii");
      cursor = end + 1;

      try {
        result.push(JSON.parse(raw) as T);
      } catch (err) {
        onError?.(raw, err as Error);
      }
    }

    // Keep only what we couldn't consume.
    this.buffer = cursor === 0 ? this.buffer : this.buffer.subarray(cursor);
    return result;
  }

  /** Reset internal state. Call on disconnect. */
  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /** Currently-buffered byte count (for diagnostics). */
  public get pendingBytes(): number {
    return this.buffer.length;
  }
}
