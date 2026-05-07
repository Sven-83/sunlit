"use strict";
/**
 * Utilities for redacting sensitive values out of log output.
 *
 * Pre-positioned for the day cloud-bound traffic gets logged. The local TCP
 * protocol carries no credentials, but a cloud token must never appear in
 * logs — not even at debug level.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.redact = redact;
exports.redactJson = redactJson;
const DEFAULT_SENSITIVE_KEYS = [
    "token",
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "password",
    "passwd",
    "pwd",
    "secret",
    "api_key",
    "apiKey",
    "authorization",
    "Authorization",
    "cloudApiToken",
];
/**
 * Replace the value of every sensitive key with '***' (depth-first).
 * Returns a new object — does not mutate the input.
 *
 * @param value
 * @param sensitiveKeys
 */
function redact(value, sensitiveKeys = DEFAULT_SENSITIVE_KEYS) {
    if (value === null || value === undefined) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((v) => redact(v, sensitiveKeys));
    }
    if (typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (sensitiveKeys.includes(k)) {
                out[k] = typeof v === "string" && v.length > 0 ? "***" : v;
            }
            else {
                out[k] = redact(v, sensitiveKeys);
            }
        }
        return out;
    }
    return value;
}
/**
 * Convenience: stringify with redaction in one call.
 *
 * @param value
 * @param sensitiveKeys
 */
function redactJson(value, sensitiveKeys = DEFAULT_SENSITIVE_KEYS) {
    return JSON.stringify(redact(value, sensitiveKeys));
}
