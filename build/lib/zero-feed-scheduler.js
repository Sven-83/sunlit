"use strict";
/**
 * Zero-feed-in scheduler — the conductor.
 *
 * Wires together the four primitives:
 *   - GridReader      → "what is the grid doing right now?"
 *   - SafetyGuard     → "are conditions safe to actuate?"
 *   - PIController    → "given the error, what setpoint?"
 *   - BK215Client     → "make it so"
 *
 * The scheduler owns the periodic tick. main.ts wires it up and stays small.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZeroFeedScheduler = void 0;
const safety_guard_1 = require("./safety-guard");
const bk215_protocol_1 = require("./bk215-protocol");
const DEFAULT_TIME_PROVIDER = {
    now: () => Date.now(),
    setInterval: (h, ms) => setInterval(h, ms),
    clearInterval: (h) => clearInterval(h),
};
class ZeroFeedScheduler {
    bk215;
    grid;
    controller;
    safetyConfig;
    targetGridW;
    intervalMs;
    sink;
    logger;
    time;
    timer = null;
    lastTickMs = null;
    failSafeActive = false;
    tickInFlight = false;
    constructor(opts) {
        if (!(opts.intervalMs >= 1000)) {
            throw new RangeError("intervalMs should be ≥ 1000 (BK215 reacts on the order of seconds)");
        }
        this.bk215 = opts.bk215;
        this.grid = opts.grid;
        this.controller = opts.controller;
        this.safetyConfig = opts.safetyConfig;
        this.targetGridW = opts.targetGridW;
        this.intervalMs = opts.intervalMs;
        this.sink = opts.sink;
        this.logger = opts.logger;
        this.time = opts.timeProvider ?? DEFAULT_TIME_PROVIDER;
    }
    start() {
        if (this.timer !== null) {
            return;
        }
        this.logger.info(`Zero-feed scheduler running every ${this.intervalMs} ms`);
        // Reset controller state on re-start so a stale integral can't kick first.
        this.controller.reset();
        this.lastTickMs = null;
        this.timer = this.time.setInterval(() => {
            void this.runTick();
        }, this.intervalMs);
    }
    async stop() {
        if (this.timer === null) {
            return;
        }
        this.time.clearInterval(this.timer);
        this.timer = null;
        // Best-effort: leave the device in a known-quiet state when the
        // controller stops. This avoids a "ghost" setpoint surviving an
        // adapter restart.
        if (this.bk215.isOpen()) {
            try {
                await this.bk215.setChargingPower(0);
                this.controller.markSent(0);
            }
            catch (err) {
                this.logger.warn(`Could not park BK215 at 0 W on stop: ${err.message}`);
            }
        }
        this.logger.info("Zero-feed scheduler stopped");
    }
    isRunning() {
        return this.timer !== null;
    }
    // -----------------------------------------------------------------------
    // Tick
    // -----------------------------------------------------------------------
    async runTick() {
        // Re-entrancy guard: if the previous tick is still doing its TCP write,
        // skip this one rather than queue up. The safety watchdog covers true
        // hangs separately.
        if (this.tickInFlight) {
            this.logger.debug("Skipping tick — previous tick still in flight");
            return;
        }
        this.tickInFlight = true;
        try {
            await this.tickInner();
        }
        catch (err) {
            this.logger.error(`Tick failed: ${err.message}`);
        }
        finally {
            this.tickInFlight = false;
        }
    }
    async tickInner() {
        const now = this.time.now();
        const status = this.bk215.getStatus();
        const snapshot = this.grid.getSnapshot();
        // Pull fields out of the BK215 status that safety needs.
        const socRaw = status[bk215_protocol_1.Field.OverallSoc];
        const soc = (0, bk215_protocol_1.isAvailable)(socRaw) ? socRaw : null;
        const localModeRaw = status[bk215_protocol_1.Field.LocalMode];
        const localModeOn = localModeRaw === 1;
        const bk215LastDataMs = Object.keys(status).length > 0 ? now : null;
        const verdict = (0, safety_guard_1.evaluateSafety)({
            bk215LinkOk: this.bk215.isOpen(),
            bk215LastDataMs,
            soc,
            localModeOn,
            gridLastUpdateMs: snapshot?.lastUpdateMs ?? null,
            gridPowerW: snapshot?.powerW ?? null,
            nowMs: now,
        }, this.safetyConfig);
        if (verdict.kind === "force-safe") {
            await this.applyFailSafe(verdict.reasonId, verdict.reasonText, soc, snapshot);
            return;
        }
        // We were in fail-safe before — announce that we left it.
        if (this.failSafeActive) {
            this.failSafeActive = false;
            await this.sink.onFailSafeChange(false, null, null);
            this.logger.info("Safety conditions restored — controller resuming");
            // Reset integral so we don't apply old wind-up to current conditions.
            this.controller.reset();
            this.lastTickMs = null;
        }
        // Time delta. First tick after start uses the configured interval as
        // a fallback so the very first PI step is well-defined.
        const dtSeconds = this.lastTickMs === null
            ? this.intervalMs / 1000
            : Math.max(0.001, (now - this.lastTickMs) / 1000);
        this.lastTickMs = now;
        // We've already vetted that snapshot is non-null inside evaluateSafety.
        const gridW = snapshot.powerW;
        const result = this.controller.update(gridW, this.targetGridW, dtSeconds);
        let didWrite = false;
        if (result.shouldSend) {
            try {
                await this.bk215.setChargingPower(result.output);
                this.controller.markSent(result.output);
                didWrite = true;
            }
            catch (err) {
                this.logger.warn(`Could not send setpoint ${result.output} W: ${err.message}`);
            }
        }
        await this.sink.onTick({
            verdict,
            appliedSetpointW: result.output,
            didWrite,
            error: result.error,
            integral: result.integral,
            saturated: result.saturated,
            rawGridW: snapshot.rawPowerW,
            smoothedGridW: snapshot.powerW,
            soc,
        });
    }
    async applyFailSafe(reasonId, reasonText, soc, snapshot) {
        const transition = !this.failSafeActive;
        this.failSafeActive = true;
        // Park the device at 0 W if we still can. Best-effort — a downed
        // link is exactly the case where this will fail, and that's fine:
        // the device's own watchdogs will react.
        let didWrite = false;
        if (this.bk215.isOpen()) {
            try {
                await this.bk215.setChargingPower(0);
                this.controller.markSent(0);
                didWrite = true;
            }
            catch (err) {
                this.logger.warn(`Fail-safe: could not write 0 W: ${err.message}`);
            }
        }
        if (transition) {
            this.logger.warn(`Fail-safe engaged: ${reasonText}`);
            await this.sink.onFailSafeChange(true, reasonId, reasonText);
        }
        await this.sink.onTick({
            verdict: { kind: "force-safe", reasonId: reasonId, reasonText },
            appliedSetpointW: 0,
            didWrite,
            error: null,
            integral: this.controller.getIntegral(),
            saturated: null,
            rawGridW: snapshot?.rawPowerW ?? null,
            smoothedGridW: snapshot?.powerW ?? null,
            soc,
        });
    }
}
exports.ZeroFeedScheduler = ZeroFeedScheduler;
