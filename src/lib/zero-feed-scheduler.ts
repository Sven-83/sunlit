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

import {
  evaluateSafety,
  type SafetyConfig,
  type SafetyVerdict,
} from "./safety-guard";
import type { PIController } from "./pi-controller";
import type { GridReader } from "./grid-reader";
import type { BK215Client } from "./bk215-client";
import { Field, isAvailable } from "./bk215-protocol";

export interface SchedulerLogger {
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

export interface SchedulerSink {
  /** Called once per tick with the verdict + chosen setpoint. */
  onTick(report: TickReport): void | Promise<void>;
  /** Called when the scheduler enters or leaves the fail-safe state. */
  onFailSafeChange(
    active: boolean,
    reasonId: string | null,
    reasonText: string | null,
  ): void | Promise<void>;
}

export interface TickReport {
  verdict: SafetyVerdict;
  /** The setpoint actually written to the device (or 0 if forced safe). */
  appliedSetpointW: number;
  /** True iff a write was actually performed this tick. */
  didWrite: boolean;
  error: number | null;
  integral: number | null;
  saturated: boolean | null;
  rawGridW: number | null;
  smoothedGridW: number | null;
  soc: number | null;
}

export interface ZeroFeedSchedulerOptions {
  bk215: BK215Client;
  grid: GridReader;
  controller: PIController;
  safetyConfig: SafetyConfig;
  targetGridW: number;
  intervalMs: number;
  sink: SchedulerSink;
  logger: SchedulerLogger;
  /** Injected for testability — defaults to global setInterval/clearInterval/Date.now. */
  timeProvider?: TimeProvider;
}

export interface TimeProvider {
  now(): number;
  setInterval(handler: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

const DEFAULT_TIME_PROVIDER: TimeProvider = {
  now: () => Date.now(),
  setInterval: (h, ms) => setInterval(h, ms),
  clearInterval: (h) => clearInterval(h),
};

export class ZeroFeedScheduler {
  private readonly bk215: BK215Client;
  private readonly grid: GridReader;
  private readonly controller: PIController;
  private readonly safetyConfig: SafetyConfig;
  private readonly targetGridW: number;
  private readonly intervalMs: number;
  private readonly sink: SchedulerSink;
  private readonly logger: SchedulerLogger;
  private readonly time: TimeProvider;

  private timer: NodeJS.Timeout | null = null;
  private lastTickMs: number | null = null;
  private failSafeActive = false;
  private tickInFlight = false;

  public constructor(opts: ZeroFeedSchedulerOptions) {
    if (!(opts.intervalMs >= 1000)) {
      throw new RangeError(
        "intervalMs should be ≥ 1000 (BK215 reacts on the order of seconds)",
      );
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

  public start(): void {
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

  public async stop(): Promise<void> {
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
      } catch (err) {
        this.logger.warn(
          `Could not park BK215 at 0 W on stop: ${(err as Error).message}`,
        );
      }
    }

    this.logger.info("Zero-feed scheduler stopped");
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  // -----------------------------------------------------------------------
  // Tick
  // -----------------------------------------------------------------------

  private async runTick(): Promise<void> {
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
    } catch (err) {
      this.logger.error(`Tick failed: ${(err as Error).message}`);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async tickInner(): Promise<void> {
    const now = this.time.now();
    const status = this.bk215.getStatus();
    const snapshot = this.grid.getSnapshot();

    // Pull fields out of the BK215 status that safety needs.
    const socRaw = status[Field.OverallSoc];
    const soc = isAvailable(socRaw) ? socRaw : null;
    const localModeRaw = status[Field.LocalMode];
    const localModeOn = localModeRaw === 1;
    const bk215LastDataMs = Object.keys(status).length > 0 ? now : null;

    const verdict = evaluateSafety(
      {
        bk215LinkOk: this.bk215.isOpen(),
        bk215LastDataMs,
        soc,
        localModeOn,
        gridLastUpdateMs: snapshot?.lastUpdateMs ?? null,
        gridPowerW: snapshot?.powerW ?? null,
        nowMs: now,
      },
      this.safetyConfig,
    );

    if (verdict.kind === "force-safe") {
      await this.applyFailSafe(
        verdict.reasonId,
        verdict.reasonText,
        soc,
        snapshot,
      );
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
    const dtSeconds =
      this.lastTickMs === null
        ? this.intervalMs / 1000
        : Math.max(0.001, (now - this.lastTickMs) / 1000);
    this.lastTickMs = now;

    // We've already vetted that snapshot is non-null inside evaluateSafety.
    const gridW = snapshot!.powerW;
    const result = this.controller.update(gridW, this.targetGridW, dtSeconds);

    let didWrite = false;
    if (result.shouldSend) {
      try {
        await this.bk215.setChargingPower(result.output);
        this.controller.markSent(result.output);
        didWrite = true;
      } catch (err) {
        this.logger.warn(
          `Could not send setpoint ${result.output} W: ${(err as Error).message}`,
        );
      }
    }

    await this.sink.onTick({
      verdict,
      appliedSetpointW: result.output,
      didWrite,
      error: result.error,
      integral: result.integral,
      saturated: result.saturated,
      rawGridW: snapshot!.rawPowerW,
      smoothedGridW: snapshot!.powerW,
      soc,
    });
  }

  private async applyFailSafe(
    reasonId: string,
    reasonText: string,
    soc: number | null,
    snapshot: ReturnType<GridReader["getSnapshot"]>,
  ): Promise<void> {
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
      } catch (err) {
        this.logger.warn(
          `Fail-safe: could not write 0 W: ${(err as Error).message}`,
        );
      }
    }

    if (transition) {
      this.logger.warn(`Fail-safe engaged: ${reasonText}`);
      await this.sink.onFailSafeChange(true, reasonId, reasonText);
    }

    await this.sink.onTick({
      verdict: { kind: "force-safe", reasonId: reasonId as never, reasonText },
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
