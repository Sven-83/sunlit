/**
 * Utilities for redacting sensitive values out of log output.
 *
 * Pre-positioned for the day cloud-bound traffic gets logged. The local TCP
 * protocol carries no credentials, but a cloud token must never appear in
 * logs — not even at debug level.
 */
/**
 * Replace the value of every sensitive key with '***' (depth-first).
 * Returns a new object — does not mutate the input.
 *
 * @param value
 * @param sensitiveKeys
 */
export declare function redact(value: unknown, sensitiveKeys?: readonly string[]): unknown;
/**
 * Convenience: stringify with redaction in one call.
 *
 * @param value
 * @param sensitiveKeys
 */
export declare function redactJson(value: unknown, sensitiveKeys?: readonly string[]): string;
