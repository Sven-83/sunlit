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
import { Socket } from "node:net";

import {
  ACK_SUCCESS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  Field,
  type FieldName,
  Limits,
  MessageCode,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  type BK215Envelope,
  type CommandPayload,
  type StatusPayload,
  assertInRange,
  isAvailable,
} from "./bk215-protocol";
import { FrameParser } from "./frame-parser";

/**
 * Minimal socket interface — exactly what the client needs from `node:net`.
 * Pulled out so tests can inject a mock without monkey-patching `node:net`.
 */
export interface SocketLike {
  setNoDelay(noDelay: boolean): void;
  connect(opts: { host: string; port: number }): unknown;
  write(data: string, encoding: "ascii", cb?: (err?: Error) => void): boolean;
  destroy(err?: Error): unknown;
  removeAllListeners(): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  once(
    event: "connect" | "error" | "close",
    listener: (...args: unknown[]) => void,
  ): unknown;
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

/** Default — uses native `setTimeout` / `clearTimeout`. */
const DEFAULT_TIMER_SERVICE: TimerService = {
  setTimeout: (h, ms) => setTimeout(h, ms),
  clearTimeout: (h) => clearTimeout(h),
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Errors (typed, so the adapter can react to them precisely)
// ---------------------------------------------------------------------------

export class BK215ProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BK215ProtocolError";
  }
}

export class BK215CommandError extends Error {
  public constructor(
    message: string,
    public readonly field: string,
    public readonly errorCode: number,
  ) {
    super(message);
    this.name = "BK215CommandError";
  }
}

export class BK215TimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BK215TimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Internal: a tiny FIFO mutex.
// Avoids pulling in `async-mutex` (and its dependency tree) just for this.
// ---------------------------------------------------------------------------

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  public async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chain = next;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Internal connection lifecycle states. Used to gate operations cleanly. */
type ClientState = "idle" | "connecting" | "open" | "closing" | "destroyed";

/**
 * Hook installed for the next ACK reply on the wire.
 * Resolved by the receive loop, rejected by command timeout.
 */
interface PendingAck {
  field: FieldName;
  resolve: (envelope: BK215Envelope) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Lookup tables (defined before the class so eslint's no-use-before-define
// rule sees them in declaration order).
// ---------------------------------------------------------------------------

/** Per-field range table, keyed by t-code, for use by `sendCommand`. */
const LIMITS_BY_FIELD: Partial<
  Record<FieldName, { min: number; max: number }>
> = {
  [Field.SystemDischargeLimit]: Limits.SystemDischargeLimit,
  [Field.SystemChargeLimit]: Limits.SystemChargeLimit,
  [Field.HomeDischargeCutoff]: Limits.HomeDischargeCutoff,
  [Field.CarDischargeCutoff]: Limits.CarDischargeCutoff,
  [Field.BatteryChargeCutoff]: Limits.BatteryChargeCutoff,
  [Field.SystemChargingPower]: Limits.SystemChargingPower,
  [Field.IdleShutdownTime]: Limits.IdleShutdownTime,
  [Field.LowBatteryShutdownTime]: Limits.LowBatteryShutdownTime,
};

function createSilentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

export class BK215Client extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly logger: Logger;
  private readonly connectTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  private socket: SocketLike | null = null;
  private state: ClientState = "idle";
  private readonly socketFactory: SocketFactory;
  private readonly timers: TimerService;

  /** Frame parser owns the byte buffer and JSON extraction. */
  private readonly parser = new FrameParser();

  /** Serialises `sendCommand` calls so the device's RX path sees one at a time. */
  private readonly txMutex = new AsyncMutex();

  /** Non-null while a command is awaiting its ACK. */
  private pendingAck: PendingAck | null = null;

  /** Backoff cursor used by the auto-reconnect loop. */
  private reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Forces a reconnect if no inbound bytes arrive in `idleTimeoutMs`. */
  private idleWatchdog: NodeJS.Timeout | null = null;

  /** Last known device state, merged from all received status reports. */
  private lastStatus: StatusPayload = {};

  public constructor(options: BK215ClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? DEFAULT_PORT;
    this.logger = options.logger ?? createSilentLogger();
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.responseTimeoutMs =
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.socketFactory =
      options.socketFactory ??
      ((): SocketLike => new Socket() as unknown as SocketLike);
    this.timers = options.timerService ?? DEFAULT_TIMER_SERVICE;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Returns true if the TCP link is up and the handshake has completed.
   * False during connect attempts, after errors, or while reconnecting.
   */
  public isOpen(): boolean {
    return this.state === "open";
  }

  /** Returns the merged device state seen so far. */
  public getStatus(): StatusSnapshot {
    return { ...this.lastStatus };
  }

  /**
   * Initiate the connection. Idempotent: calling repeatedly is harmless.
   * Resolves on the next 'open' event (or rejects if the client is destroyed
   * before that). For ongoing operation use the EventEmitter interface.
   */
  public async connect(): Promise<void> {
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
  public async sendCommand(field: FieldName, value: number): Promise<void> {
    // Pre-flight range validation for known fields.
    const range = LIMITS_BY_FIELD[field];
    if (range) {
      assertInRange(value, range, field);
    }

    return this.txMutex.runExclusive(async () => {
      if (this.state !== "open" || !this.socket) {
        throw new BK215ProtocolError(
          `Cannot send command: client state=${this.state}`,
        );
      }

      const payload: CommandPayload = { [field]: value };
      const envelope: BK215Envelope<CommandPayload> = {
        code: MessageCode.CommandSet,
        data: payload,
      };
      const wire = JSON.stringify(envelope);

      this.logger.debug(`TX: ${wire}`);

      const ackEnvelope = await new Promise<BK215Envelope>(
        (resolve, reject) => {
          const timer = this.timers.setTimeout(() => {
            if (this.pendingAck) {
              this.pendingAck = null;
              reject(
                new BK215TimeoutError(
                  `No ACK for ${field} within ${this.responseTimeoutMs}ms`,
                ),
              );
            }
          }, this.responseTimeoutMs);

          this.pendingAck = { field, resolve, reject, timer };
          this.socket!.write(wire, "ascii", (err) => {
            if (err) {
              this.timers.clearTimeout(timer);
              this.pendingAck = null;
              reject(err);
            }
          });
        },
      );

      const ackValue = (
        ackEnvelope.data as Record<string, number> | undefined
      )?.[field];
      if (ackValue !== ACK_SUCCESS) {
        throw new BK215CommandError(
          `Device rejected ${field}=${value} (ack=${ackValue})`,
          field,
          ackValue ?? -1,
        );
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
  public destroy(): Promise<void> {
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
      } catch (err) {
        // Socket already destroyed or in an odd state — log for diagnosability,
        // but don't propagate: we're tearing down and don't want to mask the
        // actual cleanup. (H3 fix.)
        this.logger.debug(
          `Socket destroy threw during cleanup (ignored): ${(err as Error).message}`,
        );
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

  public enableLocalMode(): Promise<void> {
    return this.sendCommand(Field.LocalMode, 1);
  }
  public disableLocalMode(): Promise<void> {
    return this.sendCommand(Field.LocalMode, 0);
  }
  public enableHomeApplianceMode(): Promise<void> {
    return this.sendCommand(Field.HomeApplianceMode, 1);
  }
  public disableHomeApplianceMode(): Promise<void> {
    return this.sendCommand(Field.HomeApplianceMode, 0);
  }
  public setChargingPower(watts: number): Promise<void> {
    return this.sendCommand(Field.SystemChargingPower, Math.round(watts));
  }
  public setMinDischargeSoc(percent: number): Promise<void> {
    return this.sendCommand(Field.SystemDischargeLimit, Math.round(percent));
  }
  public setMaxChargeSoc(percent: number): Promise<void> {
    return this.sendCommand(Field.SystemChargeLimit, Math.round(percent));
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle (private)
  // -----------------------------------------------------------------------

  private scheduleConnect(delayMs: number): void {
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

  private openSocket(): void {
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
      const handshake: BK215Envelope = {
        code: MessageCode.DataReport,
        data: {},
      };
      socket.write(`${JSON.stringify(handshake)}\r\n`, "ascii");

      this.socket = socket;
      this.state = "open";
      this.reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
      this.armIdleWatchdog();

      this.emit("open");
    });

    socket.on("data", (chunk: Buffer) => this.handleData(chunk));

    socket.once("error", ((err: Error) => {
      this.logger.warn(`Socket error: ${err.message}`);
      this.emit("error", err);
    }) as (...args: unknown[]) => void);

    socket.once("close", ((hadError: boolean) => {
      this.timers.clearTimeout(connectTimer);
      this.handleClose(hadError ? "socket error" : "remote closed");
    }) as (...args: unknown[]) => void);

    try {
      socket.connect({ host: this.host, port: this.port });
    } catch (err) {
      this.timers.clearTimeout(connectTimer);
      this.handleClose(`connect threw: ${(err as Error).message}`);
    }
  }

  private handleClose(reason: string): void {
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
    } else {
      this.logger.debug(`Connect attempt ended: ${reason}`);
    }

    // Schedule a reconnect with exponential backoff.
    this.scheduleConnect(this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      RECONNECT_MAX_DELAY_MS,
    );
  }

  // -----------------------------------------------------------------------
  // Receive path (private)
  // -----------------------------------------------------------------------

  private handleData(chunk: Buffer): void {
    // Any inbound traffic resets the idle watchdog.
    this.armIdleWatchdog();

    this.parser.feed(chunk);
    const frames = this.parser.drain<BK215Envelope>((raw, err) => {
      this.logger.warn(
        `Dropping malformed frame: ${err.message} (raw=${raw.slice(0, 80)})`,
      );
    });

    for (const frame of frames) {
      this.dispatchFrame(frame);
    }
  }

  private dispatchFrame(envelope: BK215Envelope): void {
    switch (envelope.code) {
      case MessageCode.DataReport:
      case MessageCode.DataReportAlt: {
        this.mergeStatus(envelope.data as StatusPayload);
        this.emit("data", this.getStatus());
        return;
      }

      case MessageCode.ResponseAck: {
        if (this.pendingAck) {
          this.timers.clearTimeout(this.pendingAck.timer);
          const { resolve } = this.pendingAck;
          this.pendingAck = null;
          resolve(envelope);
        } else {
          this.logger.debug(
            "ACK received but no command was pending; ignoring",
          );
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

  private mergeStatus(partial: StatusPayload): void {
    for (const [key, value] of Object.entries(partial)) {
      // Accept the device's "unavailable" sentinel as a deletion, so stale
      // readings of a now-removed expansion module don't linger forever.
      if (value === undefined || value === null) {
        continue;
      }
      if (isAvailable(value)) {
        this.lastStatus[key] = value;
      } else {
        delete this.lastStatus[key];
      }
    }
  }

  // -----------------------------------------------------------------------
  // Watchdog (private)
  // -----------------------------------------------------------------------

  private armIdleWatchdog(): void {
    this.clearIdleWatchdog();
    this.idleWatchdog = this.timers.setTimeout(() => {
      this.logger.warn(
        `No data for ${this.idleTimeoutMs}ms — forcing reconnect`,
      );
      if (this.socket) {
        this.socket.destroy(new Error("idle timeout"));
      }
    }, this.idleTimeoutMs);
  }

  private clearIdleWatchdog(): void {
    if (this.idleWatchdog) {
      this.timers.clearTimeout(this.idleWatchdog);
      this.idleWatchdog = null;
    }
  }

  // -----------------------------------------------------------------------
  // Helpers (private)
  // -----------------------------------------------------------------------

  /** Resolves on the next 'open' event, rejects on 'destroyed'. */
  private waitForOpen(): Promise<void> {
    if (this.state === "open") {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      // Hold both listeners in a single object so each can reference the
      // other through `pair.onOpen` / `pair.onErr` without forward refs.
      const pair: { onOpen: () => void; onErr: (err: Error) => void } = {
        onOpen: () => {
          this.removeListener("error", pair.onErr);
          resolve();
        },
        onErr: (err: Error) => {
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
