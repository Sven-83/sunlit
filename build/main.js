"use strict";
/*
 * BK215 Battery Storage adapter for ioBroker.
 *
 * Iteration 3 — controller, safety, scheduler wired in.
 *   ✓ BK215Client (TCP + protocol)
 *   ✓ GridReader (foreign-state subscription, EWMA smoothing, freshness)
 *   ✓ PIController (position-form PI, anti-windup, deadband, hysteresis)
 *   ✓ SafetyGuard (composite watchdog → fail-safe verdict)
 *   ✓ ZeroFeedScheduler (orchestrator with re-entrancy guard)
 *   ✓ Persistence of integral term across restarts
 *
 * Still to come:
 *   - jsonConfig admin UI (Iteration 4)
 *   - mDNS auto-discovery (Iteration 4)
 *   - GitHub Actions CI + adapter-checker (Iteration 5)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const bk215_client_1 = require("./lib/bk215-client");
const bk215_discovery_1 = require("./lib/bk215-discovery");
const bk215_protocol_1 = require("./lib/bk215-protocol");
const grid_reader_1 = require("./lib/grid-reader");
const pi_controller_1 = require("./lib/pi-controller");
const zero_feed_scheduler_1 = require("./lib/zero-feed-scheduler");
class Bk215Adapter extends utils.Adapter {
    bk215 = null;
    grid = null;
    controller = null;
    scheduler = null;
    constructor(options = {}) {
        super({
            ...options,
            name: "bk215",
            useFormatDate: true,
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    get cfg() {
        return this.config;
    }
    get clientLogger() {
        return {
            debug: (msg) => this.log.debug(`[bk215] ${msg}`),
            info: (msg) => this.log.info(`[bk215] ${msg}`),
            warn: (msg) => this.log.warn(`[bk215] ${msg}`),
            error: (msg) => this.log.error(`[bk215] ${msg}`),
        };
    }
    /**
     * Build a TimerService backed by `this.setTimeout` / `this.clearTimeout`.
     * The adapter base class tracks these handles and auto-clears them on
     * unload — which is what makes the client Compact-Mode-safe.
     *
     * Note on the cast: ioBroker's `setTimeout` typing returns
     * `ioBroker.Timeout | undefined`. We wrap it so consumers see a
     * Node-style `NodeJS.Timeout` and don't have to deal with `undefined`.
     * In practice, ioBroker only returns undefined when the adapter is
     * already shutting down — at that point our timer wouldn't fire anyway.
     */
    adapterTimerService() {
        return {
            setTimeout: (handler, ms) => this.setTimeout(handler, ms),
            clearTimeout: (handle) => this.clearTimeout(handle),
        };
    }
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------
    async onReady() {
        await this.setStateAsync("info.connection", { val: false, ack: true });
        this.log.info(`BK215 adapter starting up (instance ${this.namespace})`);
        let resolvedHost = this.cfg.bk215Host;
        if (!resolvedHost) {
            if (this.cfg.enableMdnsDiscovery) {
                this.log.info("No BK215 host configured — attempting mDNS discovery (10s)…");
                resolvedHost = await this.discoverBk215Host();
                if (resolvedHost) {
                    this.log.info(`Discovered BK215 at ${resolvedHost}`);
                }
                else {
                    // Hard misconfig: no host AND nothing on the LAN. Exit cleanly with
                    // ioBroker's documented "missing config" code so js-controller
                    // doesn't auto-restart us in a tight loop.
                    this.terminate?.("No BK215 host configured and mDNS discovery found no device. Open the adapter settings and enter the IP manually.", 11);
                    return;
                }
            }
            else {
                this.terminate?.("No BK215 host configured and mDNS discovery is disabled. Open the adapter settings and configure either.", 11);
                return;
            }
        }
        // Subscribe to writable own-namespace states.
        this.subscribeStates("battery.chargingPowerSetpoint");
        this.subscribeStates("battery.localMode");
        this.subscribeStates("battery.homeApplianceMode");
        this.subscribeStates("battery.socMinLimit");
        this.subscribeStates("battery.socMaxLimit");
        this.subscribeStates("controller.enabled");
        // BK215 client.
        // Inject `this.setTimeout` / `this.clearTimeout` so all timers inside
        // the client are auto-cancelled on adapter unload (Compact-Mode-safe).
        this.bk215 = new bk215_client_1.BK215Client({
            host: resolvedHost,
            port: this.cfg.bk215Port,
            logger: this.clientLogger,
            connectTimeoutMs: this.cfg.bk215ConnectTimeoutMs,
            responseTimeoutMs: this.cfg.bk215ResponseTimeoutMs,
            idleTimeoutMs: this.cfg.bk215IdleTimeoutMs,
            timerService: this.adapterTimerService(),
        });
        this.wireBk215Events(resolvedHost);
        try {
            await this.bk215.connect();
        }
        catch (err) {
            this.log.warn(`Initial connect attempt failed: ${err.message} — will keep retrying`);
        }
        // Grid reader (only if a grid state was configured).
        if (this.cfg.gridStatePath) {
            try {
                this.grid = new grid_reader_1.GridReader({
                    stateId: this.cfg.gridStatePath,
                    bus: this,
                    logger: {
                        debug: (m) => this.log.debug(`[grid] ${m}`),
                        warn: (m) => this.log.warn(`[grid] ${m}`),
                    },
                });
                this.grid.on("update", (snap) => {
                    void this.setStateAsync("grid.power", {
                        val: snap.powerW,
                        ack: true,
                    });
                    void this.setStateAsync("grid.lastUpdate", {
                        val: snap.lastUpdateMs,
                        ack: true,
                    });
                    void this.setStateAsync("grid.stale", { val: false, ack: true });
                });
                await this.grid.start();
                this.log.info(`Grid reader subscribed to ${this.cfg.gridStatePath}`);
            }
            catch (err) {
                this.log.error(`Grid reader could not start: ${err.message}`);
                this.grid = null;
            }
        }
        else {
            this.log.info("No grid-state path configured — controller will stay disabled.");
        }
        // PI controller — restore persisted integral from previous run.
        const persistedIntegral = await this.readNumber("controller.integral", 0);
        const persistedOutput = await this.readNumber("battery.chargingPower", 0);
        try {
            this.controller = new pi_controller_1.PIController({
                kp: this.cfg.controllerKp,
                ki: this.cfg.controllerKi,
                outMin: 0,
                outMax: this.cfg.inverterMaxPowerW,
                deadbandW: this.cfg.controllerDeadbandW,
                minChangeW: Math.max(1, Math.round(this.cfg.inverterMaxPowerW * 0.001)),
                initialIntegral: persistedIntegral,
                initialOutput: persistedOutput,
            });
        }
        catch (err) {
            this.log.error(`PI controller config invalid: ${err.message} — controller disabled`);
            this.controller = null;
        }
        // Scheduler — only assembled if the necessary parts are all here.
        if (this.bk215 && this.grid && this.controller) {
            this.scheduler = new zero_feed_scheduler_1.ZeroFeedScheduler({
                bk215: this.bk215,
                grid: this.grid,
                controller: this.controller,
                safetyConfig: {
                    gridStaleTimeoutS: this.cfg.gridStaleTimeoutS,
                    bk215StaleTimeoutS: Math.max(15, Math.round(this.cfg.bk215IdleTimeoutMs / 1000)),
                    socMin: this.cfg.socMin,
                    socMax: this.cfg.socMax,
                    socSafetyBufferPp: this.cfg.socSafetyBuffer,
                },
                targetGridW: this.cfg.controllerTargetGridW,
                intervalMs: this.cfg.controllerIntervalMs,
                logger: {
                    debug: (m) => this.log.debug(`[ctrl] ${m}`),
                    info: (m) => this.log.info(`[ctrl] ${m}`),
                    warn: (m) => this.log.warn(`[ctrl] ${m}`),
                    error: (m) => this.log.error(`[ctrl] ${m}`),
                },
                sink: {
                    onTick: (r) => this.onSchedulerTick(r),
                    onFailSafeChange: (active, _id, text) => this.onFailSafeChange(active, text),
                },
            });
            // Honour the configured controllerEnabled flag.
            await this.setStateAsync("controller.enabled", {
                val: this.cfg.controllerEnabled,
                ack: true,
            });
            if (this.cfg.controllerEnabled) {
                this.scheduler.start();
            }
        }
    }
    wireBk215Events(host) {
        if (!this.bk215) {
            return;
        }
        this.bk215.on("open", () => {
            void this.setStateAsync("info.connection", { val: true, ack: true });
            this.log.info(`Connected to BK215 at ${host}:${this.cfg.bk215Port}`);
        });
        this.bk215.on("close", (reason) => {
            void this.setStateAsync("info.connection", { val: false, ack: true });
            this.log.warn(`BK215 connection lost: ${reason}`);
        });
        this.bk215.on("error", (err) => {
            this.log.debug(`BK215 transient error: ${err.message}`);
        });
        this.bk215.on("data", (status) => {
            void this.publishStatus(status);
        });
    }
    // -----------------------------------------------------------------------
    // Scheduler callbacks
    // -----------------------------------------------------------------------
    async onSchedulerTick(report) {
        const writes = [];
        if (report.error !== null) {
            writes.push(this.setStateAsync("controller.error", {
                val: report.error,
                ack: true,
            }));
        }
        if (report.integral !== null) {
            writes.push(this.setStateAsync("controller.integral", {
                val: report.integral,
                ack: true,
            }));
        }
        writes.push(this.setStateAsync("controller.lastUpdate", {
            val: Date.now(),
            ack: true,
        }));
        await Promise.all(writes);
    }
    async onFailSafeChange(active, reasonText) {
        await Promise.all([
            this.setStateAsync("safety.failSafeActive", { val: active, ack: true }),
            this.setStateAsync("safety.lastReason", {
                val: reasonText ?? "",
                ack: true,
            }),
        ]);
    }
    // -----------------------------------------------------------------------
    // State change handler
    // -----------------------------------------------------------------------
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const local = id.startsWith(`${this.namespace}.`)
            ? id.slice(this.namespace.length + 1)
            : id;
        this.log.debug(`State change request: ${local} -> ${JSON.stringify(state.val)}`);
        try {
            // Controller toggle is independent of the BK215 client.
            if (local === "controller.enabled") {
                if (this.scheduler) {
                    if (state.val) {
                        this.scheduler.start();
                    }
                    else {
                        await this.scheduler.stop();
                    }
                    await this.setStateAsync("controller.enabled", {
                        val: !!state.val,
                        ack: true,
                    });
                }
                else {
                    this.log.warn("Cannot toggle controller — scheduler not initialised");
                }
                return;
            }
            if (!this.bk215) {
                this.log.warn(`State change ignored — BK215 client not initialised: ${id}`);
                return;
            }
            switch (local) {
                case "battery.chargingPowerSetpoint":
                    await this.bk215.setChargingPower(Number(state.val));
                    break;
                case "battery.localMode":
                    await (state.val
                        ? this.bk215.enableLocalMode()
                        : this.bk215.disableLocalMode());
                    break;
                case "battery.homeApplianceMode":
                    await (state.val
                        ? this.bk215.enableHomeApplianceMode()
                        : this.bk215.disableHomeApplianceMode());
                    break;
                case "battery.socMinLimit":
                    await this.bk215.setMinDischargeSoc(Number(state.val));
                    break;
                case "battery.socMaxLimit":
                    await this.bk215.setMaxChargeSoc(Number(state.val));
                    break;
                default:
                    this.log.debug(`Unhandled writable state: ${local}`);
                    return;
            }
            await this.setStateAsync(local, { val: state.val, ack: true });
        }
        catch (err) {
            if (err instanceof bk215_client_1.BK215CommandError) {
                this.log.error(`Device rejected ${err.field}: errorCode=${err.errorCode}`);
            }
            else {
                this.log.error(`Failed to apply ${local}: ${err.message}`);
            }
        }
    }
    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    async publishStatus(status) {
        const writes = [];
        const mirror = (stateId, raw) => {
            if ((0, bk215_protocol_1.isAvailable)(raw)) {
                writes.push(this.setStateAsync(stateId, { val: raw, ack: true }));
            }
        };
        mirror("battery.soc", status[bk215_protocol_1.Field.OverallSoc]);
        mirror("battery.chargingPower", status[bk215_protocol_1.Field.SystemChargingPower]);
        mirror("battery.socMinLimit", status[bk215_protocol_1.Field.SystemDischargeLimit]);
        mirror("battery.socMaxLimit", status[bk215_protocol_1.Field.SystemChargeLimit]);
        const localMode = status[bk215_protocol_1.Field.LocalMode];
        if (typeof localMode === "number") {
            writes.push(this.setStateAsync("battery.localMode", {
                val: localMode === 1,
                ack: true,
            }));
        }
        const homeMode = status[bk215_protocol_1.Field.HomeApplianceMode];
        if (typeof homeMode === "number") {
            writes.push(this.setStateAsync("battery.homeApplianceMode", {
                val: homeMode === 1,
                ack: true,
            }));
        }
        writes.push(this.setStateAsync("info.lastSync", { val: Date.now(), ack: true }));
        await Promise.all(writes);
    }
    async readNumber(stateId, fallback) {
        try {
            const s = await this.getStateAsync(stateId);
            const v = Number(s?.val);
            return Number.isFinite(v) ? v : fallback;
        }
        catch {
            return fallback;
        }
    }
    /**
     * Best-effort 10-second mDNS scan for a BK215 on the LAN. If a serial
     * number is configured, devices whose advertised serial does not match
     * are skipped — useful when there are multiple BK215s on the same LAN.
     */
    async discoverBk215Host() {
        let devices;
        try {
            devices = await bk215_discovery_1.BK215Discovery.scanOnce(10_000, {
                logger: {
                    debug: (m) => this.log.debug(`[mdns] ${m}`),
                    info: (m) => this.log.info(`[mdns] ${m}`),
                    warn: (m) => this.log.warn(`[mdns] ${m}`),
                },
            }, this.adapterTimerService());
        }
        catch (err) {
            this.log.warn(`mDNS discovery failed: ${err.message}`);
            return "";
        }
        const wantSerial = (this.cfg.bk215Serial ?? "").trim();
        const candidates = wantSerial
            ? devices.filter((d) => d.serial.toLowerCase() === wantSerial.toLowerCase())
            : devices;
        const chosen = candidates.find((d) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(d.address));
        return chosen ? chosen.address : "";
    }
    async onUnload(callback) {
        try {
            this.log.info("Shutting down BK215 adapter…");
            if (this.scheduler) {
                await this.scheduler.stop();
                this.scheduler = null;
            }
            if (this.grid) {
                await this.grid.stop();
                this.grid = null;
            }
            if (this.bk215) {
                await this.bk215.destroy();
                this.bk215 = null;
            }
            await this.setStateAsync("info.connection", { val: false, ack: true });
        }
        catch (err) {
            this.log.warn(`Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            callback();
        }
    }
}
if (require.main !== module) {
    module.exports = (options) => new Bk215Adapter(options);
}
else {
    (() => new Bk215Adapter())();
}
