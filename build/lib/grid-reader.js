"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GridReader = void 0;
const node_events_1 = require("node:events");
class GridReader extends node_events_1.EventEmitter {
    stateId;
    bus;
    alpha;
    requireGoodQuality;
    logger;
    smoothed = null;
    raw = null;
    lastUpdateMs = null;
    boundHandler = null;
    started = false;
    constructor(opts) {
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
    async start() {
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
        }
        catch (err) {
            this.logger.warn(`Failed to read initial value of ${this.stateId}: ${err.message}`);
        }
        this.started = true;
    }
    async stop() {
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
        }
        catch (err) {
            this.logger.warn(`Failed to unsubscribe ${this.stateId}: ${err.message}`);
        }
    }
    /** Returns the current snapshot or null if no value has been seen yet. */
    getSnapshot() {
        if (this.smoothed === null ||
            this.raw === null ||
            this.lastUpdateMs === null) {
            return null;
        }
        return {
            powerW: this.smoothed,
            rawPowerW: this.raw,
            lastUpdateMs: this.lastUpdateMs,
        };
    }
    getStateId() {
        return this.stateId;
    }
    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------
    handleStateChange(id, state) {
        if (id !== this.stateId) {
            return;
        }
        if (!state) {
            return;
        }
        if (this.requireGoodQuality &&
            typeof state.q === "number" &&
            state.q !== 0) {
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
        const ts = typeof state.ts === "number" && state.ts > 0 ? state.ts : Date.now();
        this.lastUpdateMs = ts;
        const snapshot = {
            powerW: this.smoothed,
            rawPowerW: this.raw,
            lastUpdateMs: this.lastUpdateMs,
        };
        this.emit("update", snapshot);
    }
}
exports.GridReader = GridReader;
