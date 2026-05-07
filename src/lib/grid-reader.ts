/**
 * Grid-meter state reader.
 *
 * Subscribes to a single configurable foreign ioBroker state (e.g. a Shelly
 * Pro 3EM total active power), tracks its freshness, and exposes a smoothed
 * value to the controller.
 *
 * Decoupled from `ioBroker.Adapter` via a small functional interface — this
 * keeps the reader testable without booting a real adapter instance.
 */

import { EventEmitter } from "node:events";

/**
 * Subset of the ioBroker.Adapter API the reader needs. The real adapter
 * satisfies it; tests can pass a stub.
 */
export interface ForeignStateBus {
  subscribeForeignStatesAsync(pattern: string): Promise<void>;
  unsubscribeForeignStatesAsync(pattern: string): Promise<void>;
  getForeignStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  on(
    event: "stateChange",
    handler: (id: string, state: ioBroker.State | null | undefined) => void,
  ): unknown;
  off(
    event: "stateChange",
    handler: (id: string, state: ioBroker.State | null | undefined) => void,
  ): unknown;
}

export interface GridReaderOptions {
  /** Full path of the ioBroker state to mirror. */
  stateId: string;
  /** Adapter-like bus for foreign-state subscription. */
  bus: ForeignStateBus;
  /**
   * Smoothing factor α ∈ [0, 1] of an exponentially-weighted moving average.
   *   α = 1 → no smoothing (raw value passed through).
   *   α = 0 → frozen (never updates) — useless, rejected.
   * Default 0.4: cuts ~60 % of single-sample spikes while keeping latency low.
   */
  smoothingAlpha?: number;
  /**
   * If true, treat states with `q !== 0` (quality flag) as untrusted and
   * skip the update. Recommended for production. Default true.
   */
  requireGoodQuality?: boolean;
  /** Logger sink. Optional. */
  logger?: { debug(m: string): void; warn(m: string): void };
}

export interface GridSnapshot {
  /** Smoothed power reading (W). */
  powerW: number;
  /** Raw most-recent reading (W) before smoothing. */
  rawPowerW: number;
  /** Wall-clock timestamp (ms) of the most recent update. */
  lastUpdateMs: number;
}

export class GridReader extends EventEmitter {
  private readonly stateId: string;
  private readonly bus: ForeignStateBus;
  private readonly alpha: number;
  private readonly requireGoodQuality: boolean;
  private readonly logger: { debug(m: string): void; warn(m: string): void };

  private smoothed: number | null = null;
  private raw: number | null = null;
  private lastUpdateMs: number | null = null;

  private boundHandler:
    | ((id: string, state: ioBroker.State | null | undefined) => void)
    | null = null;
  private started = false;

  public constructor(opts: GridReaderOptions) {
    super();

    if (!opts.stateId || opts.stateId.trim() === "") {
      throw new RangeError("stateId must be non-empty");
    }
    const alpha = opts.smoothingAlpha ?? 0.4;
    if (!(alpha > 0) || alpha > 1) {
      throw new RangeError("smoothingAlpha must be in (0, 1]");
    }

    this.stateId = opts.stateId;
    this.bus = opts.bus;
    this.alpha = alpha;
    this.requireGoodQuality = opts.requireGoodQuality ?? true;
    this.logger = opts.logger ?? {
      debug: () => undefined,
      warn: () => undefined,
    };
  }

  /**
   * Subscribe to the configured state. Idempotent.
   * Reads the current value immediately so we don't have to wait for the
   * next change to know the meter's state.
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.boundHandler = (id, state) => this.handleStateChange(id, state);
    this.bus.on("stateChange", this.boundHandler);
    await this.bus.subscribeForeignStatesAsync(this.stateId);

    // Pull the current value once so we don't sit with no data.
    try {
      const initial = await this.bus.getForeignStateAsync(this.stateId);
      if (initial) {
        this.handleStateChange(this.stateId, initial);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to read initial value of ${this.stateId}: ${(err as Error).message}`,
      );
    }

    this.started = true;
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    if (this.boundHandler) {
      this.bus.off("stateChange", this.boundHandler);
      this.boundHandler = null;
    }
    try {
      await this.bus.unsubscribeForeignStatesAsync(this.stateId);
    } catch (err) {
      this.logger.warn(
        `Failed to unsubscribe ${this.stateId}: ${(err as Error).message}`,
      );
    }
  }

  /** Returns the current snapshot or null if no value has been seen yet. */
  public getSnapshot(): GridSnapshot | null {
    if (
      this.smoothed === null ||
      this.raw === null ||
      this.lastUpdateMs === null
    ) {
      return null;
    }
    return {
      powerW: this.smoothed,
      rawPowerW: this.raw,
      lastUpdateMs: this.lastUpdateMs,
    };
  }

  public getStateId(): string {
    return this.stateId;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private handleStateChange(
    id: string,
    state: ioBroker.State | null | undefined,
  ): void {
    if (id !== this.stateId) {
      return;
    }
    if (!state) {
      return;
    }

    if (
      this.requireGoodQuality &&
      typeof state.q === "number" &&
      state.q !== 0
    ) {
      this.logger.debug(`Skipping ${id}: quality flag q=${state.q}`);
      return;
    }

    const value = Number(state.val);
    if (!Number.isFinite(value)) {
      this.logger.warn(`Non-finite value on ${id}: ${String(state.val)}`);
      return;
    }

    this.raw = value;
    this.smoothed =
      this.smoothed === null
        ? value
        : this.alpha * value + (1 - this.alpha) * this.smoothed;
    // Use the state's own timestamp if present and sane — closer to the
    // actual measurement instant than our wall clock.
    const ts =
      typeof state.ts === "number" && state.ts > 0 ? state.ts : Date.now();
    this.lastUpdateMs = ts;

    const snapshot: GridSnapshot = {
      powerW: this.smoothed,
      rawPowerW: this.raw,
      lastUpdateMs: this.lastUpdateMs,
    };
    this.emit("update", snapshot);
  }
}
