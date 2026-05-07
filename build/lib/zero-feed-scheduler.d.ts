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
import { type SafetyConfig, type SafetyVerdict } from "./safety-guard";
import type { PIController } from "./pi-controller";
import type { GridReader } from "./grid-reader";
import type { BK215Client } from "./bk215-client";
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
    onFailSafeChange(active: boolean, reasonId: string | null, reasonText: string | null): void | Promise<void>;
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
export declare class ZeroFeedScheduler {
    private readonly bk215;
    private readonly grid;
    private readonly controller;
    private readonly safetyConfig;
    private readonly targetGridW;
    private readonly intervalMs;
    private readonly sink;
    private readonly logger;
    private readonly time;
    private timer;
    private lastTickMs;
    private failSafeActive;
    private tickInFlight;
    constructor(opts: ZeroFeedSchedulerOptions);
    start(): void;
    stop(): Promise<void>;
    isRunning(): boolean;
    private runTick;
    private tickInner;
    private applyFailSafe;
}
