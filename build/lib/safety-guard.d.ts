/**
 * Safety guard — central pre-flight check evaluated *before* every controller
 * iteration and before *any* user-initiated SET command that would change
 * battery output.
 *
 * Pure logic, no I/O. Inputs are snapshots, outputs are verdicts. The adapter
 * decides what to do with the verdict (set 0 W, raise an alarm, etc.).
 *
 * Why a separate module?
 *   - Testable in isolation against contrived edge-case scenarios.
 *   - One canonical place that defines what "safe" means. If a new failure
 *     mode appears later, only this file needs touching.
 *   - The PI controller stays focused on regulation; safety policy lives here.
 */
export interface SafetyInputs {
    /** True iff the BK215 TCP link is currently open AND has produced data. */
    bk215LinkOk: boolean;
    /** Wall-clock timestamp (ms) of the last BK215 status report, or null. */
    bk215LastDataMs: number | null;
    /** Last reported overall SoC (%), or null if never seen. */
    soc: number | null;
    /** True iff `localMode` (t598) is currently enabled on the device. */
    localModeOn: boolean;
    /** Wall-clock timestamp (ms) of the last grid-meter reading, or null. */
    gridLastUpdateMs: number | null;
    /** Most recent grid power reading (W), or null. */
    gridPowerW: number | null;
    /** Current monotonic time. Injected for testability. */
    nowMs: number;
}
export interface SafetyConfig {
    /** Maximum acceptable age of a grid-meter reading (seconds). */
    gridStaleTimeoutS: number;
    /**
     * Maximum acceptable age of a BK215 status report (seconds).
     * Should comfortably exceed the device's natural reporting interval.
     */
    bk215StaleTimeoutS: number;
    /** Lower SoC bound (%) below which discharge must stop. */
    socMin: number;
    /** Upper SoC bound (%) above which charging must stop. */
    socMax: number;
    /**
     * Extra SoC buffer (percentage points) added to socMin to give us margin
     * against measurement noise and BMS hysteresis.
     */
    socSafetyBufferPp: number;
}
/**
 * Reasons safety can refuse. Stable string IDs — these are surfaced to the
 * user via `safety.lastReason` and can be matched against in scripts.
 */
export type SafetyReasonId = "bk215-link-down" | "bk215-data-stale" | "bk215-local-mode-off" | "grid-data-missing" | "grid-data-stale" | "soc-unknown" | "soc-below-min" | "soc-above-max";
export interface SafetyVerdictAllow {
    kind: "allow";
}
export interface SafetyVerdictForceSafe {
    kind: "force-safe";
    reasonId: SafetyReasonId;
    /** Human-readable description for `safety.lastReason`. */
    reasonText: string;
}
export type SafetyVerdict = SafetyVerdictAllow | SafetyVerdictForceSafe;
/**
 * Evaluates all preconditions in a fixed order. The first failure short-
 * circuits — there's no value in piling reasons on top of each other.
 *
 * Order is deliberate: cheaper / more fundamental checks first.
 *
 * @param inputs
 * @param config
 */
export declare function evaluateSafety(inputs: SafetyInputs, config: SafetyConfig): SafetyVerdict;
