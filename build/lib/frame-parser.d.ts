/**
 * JSON-over-TCP frame parser.
 *
 * Pulled out of the client because it has no I/O dependencies and is the
 * trickiest piece of logic (string-aware, escape-aware brace matching).
 * Keeping it pure makes it easy to unit-test without socket mocking.
 */
/**
 * Returns the byte offset of the matching `}` for the `{` at `start`,
 * or `-1` if the buffer does not yet contain a complete object.
 *
 * Handles strings containing braces and JSON-escaped quotes correctly.
 *
 * @param buf
 * @param start
 */
export declare function findJsonObjectEnd(buf: Buffer, start: number): number;
/**
 * Stateful frame extractor. Feed it bytes as they arrive on the socket;
 * call {@link drain} to pull out every complete JSON object that has been
 * accumulated. Incomplete trailing bytes are kept for the next round.
 */
export declare class FrameParser {
    private buffer;
    /**
     * Append more bytes from the wire.
     *
     * @param chunk
     */
    feed(chunk: Buffer): void;
    /**
     * Pulls every complete JSON object out of the internal buffer and parses it.
     * Malformed objects are skipped (and the offending slice returned via the
     * `onError` callback, if provided).
     *
     * @param onError
     */
    drain<T = unknown>(onError?: (raw: string, err: Error) => void): T[];
    /** Reset internal state. Call on disconnect. */
    reset(): void;
    /** Currently-buffered byte count (for diagnostics). */
    get pendingBytes(): number;
}
