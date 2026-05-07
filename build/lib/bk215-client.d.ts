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
import { EventEmitter } from "node:events";
import { type FieldName, type StatusPayload } from "./bk215-protocol";
/**
 * Minimal socket interface — exactly what the client needs from `node:net`.
 * Pulled out so tests can inject a mock without monkey-patching `node:net`.
 */
export interface SocketLike {
    setNoDelay(noDelay: boolean): void;
    connect(opts: {
        host: string;
        port: number;
    }): unknown;
    write(data: string, encoding: "ascii", cb?: (err?: Error) => void): boolean;
    destroy(err?: Error): unknown;
    removeAllListeners(): unknown;
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    once(event: "connect" | "error" | "close", listener: (...args: unknown[]) => void): unknown;
}
/** Factory for sockets. Defaults to a real `node:net` Socket. */
export type SocketFactory = () => SocketLike;
/**
 * Minimal timer interface — exactly what the client needs.
 * Pulled out so the adapter can inject `this.setTimeout` / `this.clearTimeout`,
 * which ioBroker auto-cleans on adapter unload (Compact-Mode-safe).
 */
export interface TimerService {
    setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
    clearTimeout(handle: NodeJS.Timeout): void;
}
/**
 * Minimal logger contract. The ioBroker `adapter.log` object satisfies it,
 * as does `console`, as does any test stub. Decoupling here keeps the
 * client easy to unit-test.
 */
export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export interface BK215ClientOptions {
    /** Device IPv4 / hostname. */
    host: string;
    /** TCP port. Default: {@link DEFAULT_PORT}. */
    port?: number;
    /** Logger sink. Default: silent. */
    logger?: Logger;
    /** Hard timeout for `socket.connect`. Default: {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
    connectTimeoutMs?: number;
    /** Per-command ACK timeout. Default: {@link DEFAULT_RESPONSE_TIMEOUT_MS}. */
    responseTimeoutMs?: number;
    /** No-data timeout that forces a reconnect. Default: {@link DEFAULT_IDLE_TIMEOUT_MS}. */
    idleTimeoutMs?: number;
    /**
     * Optional socket factory. Defaults to creating real `node:net` sockets.
     * Tests can inject a mock to drive the client without opening real connections.
     */
    socketFactory?: SocketFactory;
    /**
     * Optional timer service. Defaults to native `setTimeout` / `clearTimeout`.
     * The adapter should inject `this.setTimeout` / `this.clearTimeout` so all
     * timers are auto-cancelled on adapter unload (Compact-Mode-safe).
     */
    timerService?: TimerService;
}
/** Snapshot of accumulated device fields. Values may be missing if not yet seen. */
export type StatusSnapshot = Readonly<StatusPayload>;
export declare class BK215ProtocolError extends Error {
    constructor(message: string);
}
export declare class BK215CommandError extends Error {
    readonly field: string;
    readonly errorCode: number;
    constructor(message: string, field: string, errorCode: number);
}
export declare class BK215TimeoutError extends Error {
    constructor(message: string);
}
export declare class BK215Client extends EventEmitter {
    private readonly host;
    private readonly port;
    private readonly logger;
    private readonly connectTimeoutMs;
    private readonly responseTimeoutMs;
    private readonly idleTimeoutMs;
    private socket;
    private state;
    private readonly socketFactory;
    private readonly timers;
    /** Frame parser owns the byte buffer and JSON extraction. */
    private readonly parser;
    /** Serialises `sendCommand` calls so the device's RX path sees one at a time. */
    private readonly txMutex;
    /** Non-null while a command is awaiting its ACK. */
    private pendingAck;
    /** Backoff cursor used by the auto-reconnect loop. */
    private reconnectDelayMs;
    private reconnectTimer;
    /** Forces a reconnect if no inbound bytes arrive in `idleTimeoutMs`. */
    private idleWatchdog;
    /** Last known device state, merged from all received status reports. */
    private lastStatus;
    constructor(options: BK215ClientOptions);
    /**
     * Returns true if the TCP link is up and the handshake has completed.
     * False during connect attempts, after errors, or while reconnecting.
     */
    isOpen(): boolean;
    /** Returns the merged device state seen so far. */
    getStatus(): StatusSnapshot;
    /**
     * Initiate the connection. Idempotent: calling repeatedly is harmless.
     * Resolves on the next 'open' event (or rejects if the client is destroyed
     * before that). For ongoing operation use the EventEmitter interface.
     */
    connect(): Promise<void>;
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
    sendCommand(field: FieldName, value: number): Promise<void>;
    /**
     * Tear the client down for good. Closes the socket, cancels timers,
     * rejects any in-flight command. After this the instance is unusable.
     *
     * Synchronous body returning a resolved Promise so the public signature
     * stays `Promise<void>` (callers `await` this from async unload paths).
     */
    destroy(): Promise<void>;
    enableLocalMode(): Promise<void>;
    disableLocalMode(): Promise<void>;
    enableHomeApplianceMode(): Promise<void>;
    disableHomeApplianceMode(): Promise<void>;
    setChargingPower(watts: number): Promise<void>;
    setMinDischargeSoc(percent: number): Promise<void>;
    setMaxChargeSoc(percent: number): Promise<void>;
    private scheduleConnect;
    private openSocket;
    private handleClose;
    private handleData;
    private dispatchFrame;
    private mergeStatus;
    private armIdleWatchdog;
    private clearIdleWatchdog;
    /** Resolves on the next 'open' event, rejects on 'destroyed'. */
    private waitForOpen;
}
