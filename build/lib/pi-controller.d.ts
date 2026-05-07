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
export interface PIControllerOptions {
    /** Proportional gain. Typical: 0.5–0.9. */
    kp: number;
    /** Integral gain. Typical: 0.02–0.1. */
    ki: number;
    /** Output lower bound (W). For a discharge-only controller this is 0. */
    outMin: number;
    /** Output upper bound (W). Usually the inverter's max AC power. */
    outMax: number;
    /** Errors with |e| ≤ deadbandW are treated as zero. */
    deadbandW: number;
    /**
     * Minimum change vs. the last-sent setpoint that justifies sending again.
     * Keeps the device's RX path quiet during quasi-steady operation.
     */
    minChangeW: number;
    /** Optional: restore an integral value (e.g. from persisted ioBroker state). */
    initialIntegral?: number;
    /** Optional: restore the last-sent output (so hysteresis works after restart). */
    initialOutput?: number;
}
export interface PIUpdateResult {
    /** Watts. Already clamped to [outMin, outMax]. Always non-NaN. */
    output: number;
    /** True ⇔ output differs from the last sent value by ≥ minChangeW. */
    shouldSend: boolean;
    /** The (possibly deadbanded) error that drove this iteration. */
    error: number;
    /** The accumulated integral term after this iteration. */
    integral: number;
    /** True if the output saturated at outMin or outMax. */
    saturated: boolean;
}
export declare class PIController {
    private readonly kp;
    private readonly ki;
    private readonly outMin;
    private readonly outMax;
    private readonly deadbandW;
    private readonly minChangeW;
    private integral;
    /** Last value the controller actually emitted. */
    private lastOutput;
    /** Last value the caller actually sent on the wire. */
    private lastSentOutput;
    constructor(opts: PIControllerOptions);
    getIntegral(): number;
    getLastOutput(): number;
    /**
     * Mark a setpoint as "sent". Tells the hysteresis check what the device
     * actually believes is current. Call this AFTER the wire write succeeds.
     *
     * @param output
     */
    markSent(output: number): void;
    /**
     * Reset the integral and last-output. Use when (re-)enabling the
     * controller, or after an emergency stop, to avoid windup carry-over.
     *
     * @param initialOutput
     */
    reset(initialOutput?: number): void;
    /**
     * One controller iteration.
     *
     * @param gridPowerW    Current net grid power, watts. + = import, − = export.
     * @param targetGridW   Desired net grid power. 0 for pure zero-feed-in.
     * @param dtSeconds     Elapsed time since the previous update. Use the actual
     *                      measured interval, not a constant — protects against
     *                      scheduler jitter.
     */
    update(gridPowerW: number, targetGridW: number, dtSeconds: number): PIUpdateResult;
}
