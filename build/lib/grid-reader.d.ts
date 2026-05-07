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
    on(event: "stateChange", handler: (id: string, state: ioBroker.State | null | undefined) => void): unknown;
    off(event: "stateChange", handler: (id: string, state: ioBroker.State | null | undefined) => void): unknown;
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
    logger?: {
        debug(m: string): void;
        warn(m: string): void;
    };
}
export interface GridSnapshot {
    /** Smoothed power reading (W). */
    powerW: number;
    /** Raw most-recent reading (W) before smoothing. */
    rawPowerW: number;
    /** Wall-clock timestamp (ms) of the most recent update. */
    lastUpdateMs: number;
}
export declare class GridReader extends EventEmitter {
    private readonly stateId;
    private readonly bus;
    private readonly alpha;
    private readonly requireGoodQuality;
    private readonly logger;
    private smoothed;
    private raw;
    private lastUpdateMs;
    private boundHandler;
    private started;
    constructor(opts: GridReaderOptions);
    /**
     * Subscribe to the configured state. Idempotent.
     * Reads the current value immediately so we don't have to wait for the
     * next change to know the meter's state.
     */
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Returns the current snapshot or null if no value has been seen yet. */
    getSnapshot(): GridSnapshot | null;
    getStateId(): string;
    private handleStateChange;
}
