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
export type SafetyReasonId =
  | "bk215-link-down"
  | "bk215-data-stale"
  | "bk215-local-mode-off"
  | "grid-data-missing"
  | "grid-data-stale"
  | "soc-unknown"
  | "soc-below-min"
  | "soc-above-max";

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
export function evaluateSafety(
  inputs: SafetyInputs,
  config: SafetyConfig,
): SafetyVerdict {
  // ------------------------------------------------------------------
  // 1) BK215 link & freshness
  // ------------------------------------------------------------------

  if (!inputs.bk215LinkOk) {
    return {
      kind: "force-safe",
      reasonId: "bk215-link-down",
      reasonText: "BK215 TCP link is not open",
    };
  }

  if (inputs.bk215LastDataMs === null) {
    return {
      kind: "force-safe",
      reasonId: "bk215-data-stale",
      reasonText: "No status report received from BK215 yet",
    };
  }

  const bk215AgeS = (inputs.nowMs - inputs.bk215LastDataMs) / 1000;
  if (bk215AgeS > config.bk215StaleTimeoutS) {
    return {
      kind: "force-safe",
      reasonId: "bk215-data-stale",
      reasonText: `BK215 data stale (${bk215AgeS.toFixed(1)}s > ${config.bk215StaleTimeoutS}s)`,
    };
  }

  // ------------------------------------------------------------------
  // 2) Local mode must be on, otherwise SET commands are silently ignored
  //    by the device — that would be a nasty silent failure.
  // ------------------------------------------------------------------

  if (!inputs.localModeOn) {
    return {
      kind: "force-safe",
      reasonId: "bk215-local-mode-off",
      reasonText: "Local mode is disabled on BK215 — controller cannot operate",
    };
  }

  // ------------------------------------------------------------------
  // 3) Grid meter freshness — without a recent reading the controller
  //    is regulating against a phantom and could runaway.
  // ------------------------------------------------------------------

  if (inputs.gridLastUpdateMs === null || inputs.gridPowerW === null) {
    return {
      kind: "force-safe",
      reasonId: "grid-data-missing",
      reasonText: "No grid-meter reading received yet",
    };
  }

  const gridAgeS = (inputs.nowMs - inputs.gridLastUpdateMs) / 1000;
  if (gridAgeS > config.gridStaleTimeoutS) {
    return {
      kind: "force-safe",
      reasonId: "grid-data-stale",
      reasonText: `Grid data stale (${gridAgeS.toFixed(1)}s > ${config.gridStaleTimeoutS}s)`,
    };
  }

  // ------------------------------------------------------------------
  // 4) SoC bounds — last because they're the most "operational" of the
  //    checks. Connectivity issues should win over SoC issues in the log.
  // ------------------------------------------------------------------

  if (inputs.soc === null) {
    return {
      kind: "force-safe",
      reasonId: "soc-unknown",
      reasonText: "SoC has not been reported yet",
    };
  }

  const effectiveMin = config.socMin + config.socSafetyBufferPp;
  if (inputs.soc < effectiveMin) {
    return {
      kind: "force-safe",
      reasonId: "soc-below-min",
      reasonText: `SoC ${inputs.soc}% below safety floor ${effectiveMin}% (min ${config.socMin}% + ${config.socSafetyBufferPp}pp buffer)`,
    };
  }

  if (inputs.soc > config.socMax) {
    return {
      kind: "force-safe",
      reasonId: "soc-above-max",
      reasonText: `SoC ${inputs.soc}% above ceiling ${config.socMax}%`,
    };
  }

  return { kind: "allow" };
}
