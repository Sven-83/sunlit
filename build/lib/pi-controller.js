"use strict";
/**
 * Position-form PI controller for zero-feed-in regulation.
 *
 * Pure logic, no I/O — call {@link update} from a scheduler.
 *
 * Design choices:
 *
 *  1. Position form (not incremental). Output is the absolute charging-power
 *     setpoint in watts, computed from the current error plus an accumulated
 *     integral. The integral is persisted across adapter restarts so the
 *     controller picks up where it left off.
 *
 *  2. Conditional-integration anti-windup. The integral does NOT accumulate
 *     while the output is saturated *and* the error would push it further
 *     into saturation. This is mathematically cleaner than back-calculation
 *     for our use-case: the actuator (charging power) is the only signal
 *     we set, there is no separate "tracking" channel.
 *
 *  3. Deadband around zero error. Within ±deadbandW the error is treated as
 *     zero. Avoids hardware wear from chasing measurement noise.
 *
 *  4. Hysteresis on the output. If the new setpoint differs from the
 *     last-sent one by less than `minChangeW`, the caller is asked NOT to
 *     send anything. Returned via the `shouldSend` flag — the controller
 *     itself never talks to the wire.
 *
 * Sign convention:
 *   grid_power > 0  →  importing from the grid     (need MORE discharge)
 *   grid_power < 0  →  exporting to the grid       (need LESS discharge)
 *   target = 0      →  pure zero-feed-in
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PIController = void 0;
class PIController {
    kp;
    ki;
    outMin;
    outMax;
    deadbandW;
    minChangeW;
    integral;
    /** Last value the controller actually emitted. */
    lastOutput;
    /** Last value the caller actually sent on the wire. */
    lastSentOutput = null;
    constructor(opts) {
        if (!Number.isFinite(opts.kp) || opts.kp <= 0) {
            throw new RangeError("kp must be > 0");
        }
        if (!Number.isFinite(opts.ki) || opts.ki < 0) {
            throw new RangeError("ki must be ≥ 0");
        }
        if (opts.outMax <= opts.outMin) {
            throw new RangeError("outMax must be > outMin");
        }
        if (opts.deadbandW < 0) {
            throw new RangeError("deadbandW must be ≥ 0");
        }
        if (opts.minChangeW < 0) {
            throw new RangeError("minChangeW must be ≥ 0");
        }
        this.kp = opts.kp;
        this.ki = opts.ki;
        this.outMin = opts.outMin;
        this.outMax = opts.outMax;
        this.deadbandW = opts.deadbandW;
        this.minChangeW = opts.minChangeW;
        this.integral = clamp(opts.initialIntegral ?? 0, -opts.outMax, opts.outMax);
        this.lastOutput = clamp(opts.initialOutput ?? 0, opts.outMin, opts.outMax);
    }
    getIntegral() {
        return this.integral;
    }
    getLastOutput() {
        return this.lastOutput;
    }
    /**
     * Mark a setpoint as "sent". Tells the hysteresis check what the device
     * actually believes is current. Call this AFTER the wire write succeeds.
     *
     * @param output
     */
    markSent(output) {
        this.lastSentOutput = output;
    }
    /**
     * Reset the integral and last-output. Use when (re-)enabling the
     * controller, or after an emergency stop, to avoid windup carry-over.
     *
     * @param initialOutput
     */
    reset(initialOutput = 0) {
        this.integral = 0;
        this.lastOutput = clamp(initialOutput, this.outMin, this.outMax);
        this.lastSentOutput = null;
    }
    /**
     * One controller iteration.
     *
     * @param gridPowerW    Current net grid power, watts. + = import, − = export.
     * @param targetGridW   Desired net grid power. 0 for pure zero-feed-in.
     * @param dtSeconds     Elapsed time since the previous update. Use the actual
     *                      measured interval, not a constant — protects against
     *                      scheduler jitter.
     */
    update(gridPowerW, targetGridW, dtSeconds) {
        if (!Number.isFinite(gridPowerW) || !Number.isFinite(targetGridW)) {
            throw new RangeError("gridPowerW and targetGridW must be finite numbers");
        }
        if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds)) {
            throw new RangeError("dtSeconds must be a positive finite number");
        }
        // Raw error — controller convention: positive error = need MORE discharge.
        const rawError = gridPowerW - targetGridW;
        // Deadband: ignore tiny errors so the device doesn't chase noise.
        const error = Math.abs(rawError) <= this.deadbandW ? 0 : rawError;
        // Tentative integral update.
        const integralCandidate = this.integral + this.ki * dtSeconds * error;
        // Tentative output (P + I).
        const uCandidate = this.kp * error + integralCandidate;
        const uClamped = clamp(uCandidate, this.outMin, this.outMax);
        const saturated = uClamped !== uCandidate;
        // Conditional integration anti-windup:
        // freeze the integral when output is saturated AND the error
        // would push it further into the saturated region.
        let nextIntegral;
        if (saturated) {
            const drivingFurther = (uCandidate > this.outMax && error > 0) ||
                (uCandidate < this.outMin && error < 0);
            nextIntegral = drivingFurther ? this.integral : integralCandidate;
        }
        else {
            nextIntegral = integralCandidate;
        }
        // Hard-cap the integral itself as a belt-and-braces against runaway state.
        // The bound mirrors the output range so a fully-wound integral can still
        // produce a sensible setpoint on its own.
        nextIntegral = clamp(nextIntegral, -this.outMax, this.outMax);
        this.integral = nextIntegral;
        this.lastOutput = uClamped;
        // Hysteresis: should the caller actually send this?
        const reference = this.lastSentOutput ?? Number.NaN;
        const shouldSend = !Number.isFinite(reference) ||
            Math.abs(uClamped - reference) >= this.minChangeW;
        return {
            output: uClamped,
            shouldSend,
            error,
            integral: nextIntegral,
            saturated,
        };
    }
}
exports.PIController = PIController;
function clamp(value, lo, hi) {
    if (value < lo) {
        return lo;
    }
    if (value > hi) {
        return hi;
    }
    return value;
}
