"use strict";
/**
 * Resilient TCP client for the BK215 / SunEnergyXT battery storage system.
 *
 * Responsibilities (and ONLY these — no business logic, no controller):
 *   - Maintain a persistent TCP connection to the device on port 8000.
 *   - Perform the handshake required to start the status stream.
 *   - Parse the JSON-over-TCP frame format robustly.
 *   - Serialise outbound SET commands so the device's small RX buffer
 *     never gets two commands at once.
 *   - Reconnect with exponential backoff on any failure.
 *   - Detect a dead link via an idle-watchdog and force a reset.
 *
 * The class is a Node.js `EventEmitter` and exposes:
 *   - 'open'   ()                                 — handshake completed
 *   - 'close'  (reason: string)                   — link is down
 *   - 'data'   (status: StatusSnapshot)           — merged device state
 *   - 'error'  (error: Error)                     — non-fatal, will reconnect
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BK215Client = exports.BK215TimeoutError = exports.BK215CommandError = exports.BK215ProtocolError = void 0;
const node_events_1 = require("node:events");
const node_net_1 = require("node:net");
const bk215_protocol_1 = require("./bk215-protocol");
const frame_parser_1 = require("./frame-parser");
/** Default — uses native `setTimeout` / `clearTimeout`. */
const DEFAULT_TIMER_SERVICE = {
    setTimeout: (h, ms) => setTimeout(h, ms),
    clearTimeout: (h) => clearTimeout(h),
};
// ---------------------------------------------------------------------------
// Errors (typed, so the adapter can react to them precisely)
// ---------------------------------------------------------------------------
class BK215ProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = "BK215ProtocolError";
    }
}
exports.BK215ProtocolError = BK215ProtocolError;
class BK215CommandError extends Error {
    field;
    errorCode;
    constructor(message, field, errorCode) {
        super(message);
        this.field = field;
        this.errorCode = errorCode;
        this.name = "BK215CommandError";
    }
}
exports.BK215CommandError = BK215CommandError;
class BK215TimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = "BK215TimeoutError";
    }
}
exports.BK215TimeoutError = BK215TimeoutError;
// ---------------------------------------------------------------------------
// Internal: a tiny FIFO mutex.
// Avoids pulling in `async-mutex` (and its dependency tree) just for this.
// ---------------------------------------------------------------------------
class AsyncMutex {
    chain = Promise.resolve();
    async runExclusive(fn) {
        const previous = this.chain;
        let release;
        const next = new Promise((resolve) => {
            release = resolve;
        });
        this.chain = next;
        await previous;
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
}
// ---------------------------------------------------------------------------
// Lookup tables (defined before the class so eslint's no-use-before-define
// rule sees them in declaration order).
// ---------------------------------------------------------------------------
/** Per-field range table, keyed by t-code, for use by `sendCommand`. */
const LIMITS_BY_FIELD = {
    [bk215_protocol_1.Field.SystemDischargeLimit]: bk215_protocol_1.Limits.SystemDischargeLimit,
    [bk215_protocol_1.Field.SystemChargeLimit]: bk215_protocol_1.Limits.SystemChargeLimit,
    [bk215_protocol_1.Field.HomeDischargeCutoff]: bk215_protocol_1.Limits.HomeDischargeCutoff,
    [bk215_protocol_1.Field.CarDischargeCutoff]: bk215_protocol_1.Limits.CarDischargeCutoff,
    [bk215_protocol_1.Field.BatteryChargeCutoff]: bk215_protocol_1.Limits.BatteryChargeCutoff,
    [bk215_protocol_1.Field.SystemChargingPower]: bk215_protocol_1.Limits.SystemChargingPower,
    [bk215_protocol_1.Field.IdleShutdownTime]: bk215_protocol_1.Limits.IdleShutdownTime,
    [bk215_protocol_1.Field.LowBatteryShutdownTime]: bk215_protocol_1.Limits.LowBatteryShutdownTime,
};
function createSilentLogger() {
    return {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    };
}
class BK215Client extends node_events_1.EventEmitter {
    host;
    port;
    logger;
    connectTimeoutMs;
    responseTimeoutMs;
    idleTimeoutMs;
    socket = null;
    state = "idle";
    socketFactory;
    timers;
    /** Frame parser owns the byte buffer and JSON extraction. */
    parser = new frame_parser_1.FrameParser();
    /** Serialises `sendCommand` calls so the device's RX path sees one at a time. */
    txMutex = new AsyncMutex();
    /** Non-null while a command is awaiting its ACK. */
    pendingAck = null;
    /** Backoff cursor used by the auto-reconnect loop. */
    reconnectDelayMs = bk215_protocol_1.RECONNECT_INITIAL_DELAY_MS;
    reconnectTimer = null;
    /** Forces a reconnect if no inbound bytes arrive in `idleTimeoutMs`. */
    idleWatchdog = null;
    /** Last known device state, merged from all received status reports. */
    lastStatus = {};
    constructor(options) {
        super();
        this.host = options.host;
        this.port = options.port ?? bk215_protocol_1.DEFAULT_PORT;
        this.logger = options.logger ?? createSilentLogger();
        this.connectTimeoutMs =
            options.connectTimeoutMs ?? bk215_protocol_1.DEFAULT_CONNECT_TIMEOUT_MS;
        this.responseTimeoutMs =
            options.responseTimeoutMs ?? bk215_protocol_1.DEFAULT_RESPONSE_TIMEOUT_MS;
        this.idleTimeoutMs = options.idleTimeoutMs ?? bk215_protocol_1.DEFAULT_IDLE_TIMEOUT_MS;
        this.socketFactory =
            options.socketFactory ??
                (() => new node_net_1.Socket());
        this.timers = options.timerService ?? DEFAULT_TIMER_SERVICE;
    }
    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    /**
     * Returns true if the TCP link is up and the handshake has completed.
     * False during connect attempts, after errors, or while reconnecting.
     */
    isOpen() {
        return this.state === "open";
    }
    /** Returns the merged device state seen so far. */
    getStatus() {
        return { ...this.lastStatus };
    }
    /**
     * Initiate the connection. Idempotent: calling repeatedly is harmless.
     * Resolves on the next 'open' event (or rejects if the client is destroyed
     * before that). For ongoing operation use the EventEmitter interface.
     */
    async connect() {
        if (this.state === "destroyed") {
            throw new Error("BK215Client has been destroyed");
        }
        if (this.state === "open") {
            return;
        }
        if (this.state !== "connecting") {
            this.scheduleConnect(0);
        }
        await this.waitForOpen();
    }
    /**
     * Send a SET command. The device's per-field ACK is awaited; success
     * means the field was applied (ACK value === {@link ACK_SUCCESS}).
     *
     * Range-checks are enforced *before* hitting the wire to avoid
     * obviously-bogus traffic.
     *
     * @param field
     * @param value
     */
    async sendCommand(field, value) {
        // Pre-flight range validation for known fields.
        const range = LIMITS_BY_FIELD[field];
        if (range) {
            (0, bk215_protocol_1.assertInRange)(value, range, field);
        }
        return this.txMutex.runExclusive(async () => {
            if (this.state !== "open" || !this.socket) {
                throw new BK215ProtocolError(`Cannot send command: client state=${this.state}`);
            }
            const payload = { [field]: value };
            const envelope = {
                code: bk215_protocol_1.MessageCode.CommandSet,
                data: payload,
            };
            const wire = JSON.stringify(envelope);
            this.logger.debug(`TX: ${wire}`);
            const ackEnvelope = await new Promise((resolve, reject) => {
                const timer = this.timers.setTimeout(() => {
                    if (this.pendingAck) {
                        this.pendingAck = null;
                        reject(new BK215TimeoutError(`No ACK for ${field} within ${this.responseTimeoutMs}ms`));
                    }
                }, this.responseTimeoutMs);
                this.pendingAck = { field, resolve, reject, timer };
                this.socket.write(wire, "ascii", (err) => {
                    if (err) {
                        this.timers.clearTimeout(timer);
                        this.pendingAck = null;
                        reject(err);
                    }
                });
            });
            const ackValue = ackEnvelope.data?.[field];
            if (ackValue !== bk215_protocol_1.ACK_SUCCESS) {
                throw new BK215CommandError(`Device rejected ${field}=${value} (ack=${ackValue})`, field, ackValue ?? -1);
            }
        });
    }
    /**
     * Tear the client down for good. Closes the socket, cancels timers,
     * rejects any in-flight command. After this the instance is unusable.
     *
     * Synchronous body returning a resolved Promise so the public signature
     * stays `Promise<void>` (callers `await` this from async unload paths).
     */
    destroy() {
        if (this.state === "destroyed") {
            return Promise.resolve();
        }
        this.state = "destroyed";
        if (this.reconnectTimer) {
            this.timers.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.clearIdleWatchdog();
        if (this.pendingAck) {
            this.timers.clearTimeout(this.pendingAck.timer);
            this.pendingAck.reject(new Error("Client destroyed"));
            this.pendingAck = null;
        }
        if (this.socket) {
            this.socket.removeAllListeners();
            try {
                this.socket.destroy();
            }
            catch (err) {
                // Socket already destroyed or in an odd state — log for diagnosability,
                // but don't propagate: we're tearing down and don't want to mask the
                // actual cleanup. (H3 fix.)
                this.logger.debug(`Socket destroy threw during cleanup (ignored): ${err.message}`);
            }
            this.socket = null;
        }
        this.removeAllListeners();
        return Promise.resolve();
    }
    // -----------------------------------------------------------------------
    // Convenience wrappers around sendCommand
    //
    // Each is a one-liner. They exist for two reasons:
    //   1. Self-documenting calls at the adapter layer.
    //   2. A single place to add side-effects (e.g. local-state mirroring)
    //      should we ever need to.
    // -----------------------------------------------------------------------
    enableLocalMode() {
        return this.sendCommand(bk215_protocol_1.Field.LocalMode, 1);
    }
    disableLocalMode() {
        return this.sendCommand(bk215_protocol_1.Field.LocalMode, 0);
    }
    enableHomeApplianceMode() {
        return this.sendCommand(bk215_protocol_1.Field.HomeApplianceMode, 1);
    }
    disableHomeApplianceMode() {
        return this.sendCommand(bk215_protocol_1.Field.HomeApplianceMode, 0);
    }
    setChargingPower(watts) {
        return this.sendCommand(bk215_protocol_1.Field.SystemChargingPower, Math.round(watts));
    }
    setMinDischargeSoc(percent) {
        return this.sendCommand(bk215_protocol_1.Field.SystemDischargeLimit, Math.round(percent));
    }
    setMaxChargeSoc(percent) {
        return this.sendCommand(bk215_protocol_1.Field.SystemChargeLimit, Math.round(percent));
    }
    // -----------------------------------------------------------------------
    // Connection lifecycle (private)
    // -----------------------------------------------------------------------
    scheduleConnect(delayMs) {
        if (this.state === "destroyed") {
            return;
        }
        if (this.reconnectTimer) {
            this.timers.clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = this.timers.setTimeout(() => {
            this.reconnectTimer = null;
            this.openSocket();
        }, delayMs);
    }
    openSocket() {
        if (this.state === "destroyed") {
            return;
        }
        this.state = "connecting";
        this.parser.reset();
        this.logger.debug(`Connecting to ${this.host}:${this.port}…`);
        const socket = this.socketFactory();
        socket.setNoDelay(true);
        // Hard timeout for the connect phase. Cleared once we've handshaken.
        const connectTimer = this.timers.setTimeout(() => {
            this.logger.warn(`Connect timeout after ${this.connectTimeoutMs}ms`);
            socket.destroy(new Error("connect timeout"));
        }, this.connectTimeoutMs);
        socket.once("connect", () => {
            this.timers.clearTimeout(connectTimer);
            this.logger.debug("TCP connected, sending handshake");
            // The device requires a handshake before it starts streaming.
            // The "\r\n" terminator here is part of the documented protocol.
            const handshake = {
                code: bk215_protocol_1.MessageCode.DataReport,
                data: {},
            };
            socket.write(`${JSON.stringify(handshake)}\r\n`, "ascii");
            this.socket = socket;
            this.state = "open";
            this.reconnectDelayMs = bk215_protocol_1.RECONNECT_INITIAL_DELAY_MS;
            this.armIdleWatchdog();
            this.emit("open");
        });
        socket.on("data", (chunk) => this.handleData(chunk));
        socket.once("error", ((err) => {
            this.logger.warn(`Socket error: ${err.message}`);
            this.emit("error", err);
        }));
        socket.once("close", ((hadError) => {
            this.timers.clearTimeout(connectTimer);
            this.handleClose(hadError ? "socket error" : "remote closed");
        }));
        try {
            socket.connect({ host: this.host, port: this.port });
        }
        catch (err) {
            this.timers.clearTimeout(connectTimer);
            this.handleClose(`connect threw: ${err.message}`);
        }
    }
    handleClose(reason) {
        if (this.state === "destroyed") {
            return;
        }
        const wasOpen = this.state === "open";
        this.state = "idle";
        this.clearIdleWatchdog();
        this.parser.reset();
        if (this.pendingAck) {
            this.timers.clearTimeout(this.pendingAck.timer);
            this.pendingAck.reject(new Error(`Connection closed: ${reason}`));
            this.pendingAck = null;
        }
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket = null;
        }
        if (wasOpen) {
            this.logger.info(`Disconnected: ${reason}`);
            this.emit("close", reason);
        }
        else {
            this.logger.debug(`Connect attempt ended: ${reason}`);
        }
        // Schedule a reconnect with exponential backoff.
        this.scheduleConnect(this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, bk215_protocol_1.RECONNECT_MAX_DELAY_MS);
    }
    // -----------------------------------------------------------------------
    // Receive path (private)
    // -----------------------------------------------------------------------
    handleData(chunk) {
        // Any inbound traffic resets the idle watchdog.
        this.armIdleWatchdog();
        this.parser.feed(chunk);
        const frames = this.parser.drain((raw, err) => {
            this.logger.warn(`Dropping malformed frame: ${err.message} (raw=${raw.slice(0, 80)})`);
        });
        for (const frame of frames) {
            this.dispatchFrame(frame);
        }
    }
    dispatchFrame(envelope) {
        switch (envelope.code) {
            case bk215_protocol_1.MessageCode.DataReport:
            case bk215_protocol_1.MessageCode.DataReportAlt: {
                this.mergeStatus(envelope.data);
                this.emit("data", this.getStatus());
                return;
            }
            case bk215_protocol_1.MessageCode.ResponseAck: {
                if (this.pendingAck) {
                    this.timers.clearTimeout(this.pendingAck.timer);
                    const { resolve } = this.pendingAck;
                    this.pendingAck = null;
                    resolve(envelope);
                }
                else {
                    this.logger.debug("ACK received but no command was pending; ignoring");
                }
                return;
            }
            default: {
                // The handshake reply is `{"code":0,"data":{}}` — silently ignored.
                if (envelope.code === 0) {
                    return;
                }
                this.logger.debug(`Unknown frame code=${envelope.code}; ignoring`);
            }
        }
    }
    mergeStatus(partial) {
        for (const [key, value] of Object.entries(partial)) {
            // Accept the device's "unavailable" sentinel as a deletion, so stale
            // readings of a now-removed expansion module don't linger forever.
            if (value === undefined || value === null) {
                continue;
            }
            if ((0, bk215_protocol_1.isAvailable)(value)) {
                this.lastStatus[key] = value;
            }
            else {
                delete this.lastStatus[key];
            }
        }
    }
    // -----------------------------------------------------------------------
    // Watchdog (private)
    // -----------------------------------------------------------------------
    armIdleWatchdog() {
        this.clearIdleWatchdog();
        this.idleWatchdog = this.timers.setTimeout(() => {
            this.logger.warn(`No data for ${this.idleTimeoutMs}ms — forcing reconnect`);
            if (this.socket) {
                this.socket.destroy(new Error("idle timeout"));
            }
        }, this.idleTimeoutMs);
    }
    clearIdleWatchdog() {
        if (this.idleWatchdog) {
            this.timers.clearTimeout(this.idleWatchdog);
            this.idleWatchdog = null;
        }
    }
    // -----------------------------------------------------------------------
    // Helpers (private)
    // -----------------------------------------------------------------------
    /** Resolves on the next 'open' event, rejects on 'destroyed'. */
    waitForOpen() {
        if (this.state === "open") {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            // Hold both listeners in a single object so each can reference the
            // other through `pair.onOpen` / `pair.onErr` without forward refs.
            const pair = {
                onOpen: () => {
                    this.removeListener("error", pair.onErr);
                    resolve();
                },
                onErr: (err) => {
                    if (this.state === "destroyed") {
                        this.removeListener("open", pair.onOpen);
                        reject(err);
                    }
                },
            };
            this.once("open", pair.onOpen);
            this.on("error", pair.onErr);
        });
    }
}
exports.BK215Client = BK215Client;
