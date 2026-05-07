"use strict";
/**
 * mDNS/Bonjour discovery for SunEnergyXT BK215 devices.
 *
 * The device advertises itself on the LAN under:
 *   - service type:  _http._tcp.local.
 *   - identifier:    `hp-bk215` appears either in the service name, the TXT
 *                    record, or the hostname (firmware-dependent).
 *
 * We deliberately decouple from the concrete `bonjour-service` import via a
 * tiny `BonjourLike` interface — this lets tests inject an in-memory mock
 * without monkey-patching modules.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BK215Discovery = void 0;
const node_events_1 = require("node:events");
const bk215_protocol_1 = require("./bk215-protocol");
// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
/**
 * Live mDNS browser. `start()` begins listening; `stop()` releases sockets.
 * Emits a 'found' event for every BK215 advertisement that matches the
 * identifier filter.
 */
class BK215Discovery extends node_events_1.EventEmitter {
    bonjourFactory;
    logger;
    identifier;
    bonjour = null;
    browser = null;
    seen = new Map();
    constructor(opts = {}) {
        super();
        this.bonjourFactory = opts.bonjourFactory ?? defaultBonjourFactory;
        this.logger = opts.logger ?? silentLogger();
        this.identifier = opts.identifier ?? bk215_protocol_1.MDNS_DEVICE_IDENTIFIER;
    }
    /** Begin browsing. Idempotent. */
    start() {
        if (this.browser) {
            return;
        }
        this.bonjour = this.bonjourFactory();
        this.browser = this.bonjour.find({ type: bk215_protocol_1.MDNS_SERVICE_TYPE, protocol: "tcp" }, (svc) => {
            this.handleService(svc);
        });
        this.logger.debug(`mDNS browsing for _${bk215_protocol_1.MDNS_SERVICE_TYPE}._tcp (filter: "${this.identifier}")`);
    }
    /** Stop browsing and release the underlying socket(s). Idempotent. */
    stop() {
        if (this.browser) {
            try {
                this.browser.stop();
            }
            catch (err) {
                this.logger.warn(`Browser stop failed: ${err.message}`);
            }
            this.browser = null;
        }
        if (this.bonjour) {
            try {
                this.bonjour.destroy();
            }
            catch (err) {
                this.logger.warn(`Bonjour destroy failed: ${err.message}`);
            }
            this.bonjour = null;
        }
        this.seen.clear();
    }
    /** Snapshot of devices seen so far. */
    getDevices() {
        return Array.from(this.seen.values());
    }
    /**
     * One-shot helper: start a browser, collect for `timeoutMs`, then stop and
     * return everything found. Intended for the admin UI's "scan now" button.
     *
     * `timerService` lets the adapter inject `this.setTimeout` so the scan's
     * timeout is auto-cancelled if the adapter is unloaded mid-scan.
     *
     * @param timeoutMs
     * @param opts
     * @param timerService
     * @param timerService.setTimeout
     * @param timerService.clearTimeout
     */
    static async scanOnce(timeoutMs, opts = {}, timerService) {
        const d = new BK215Discovery(opts);
        d.start();
        try {
            await new Promise((resolve) => {
                if (timerService) {
                    timerService.setTimeout(() => resolve(), timeoutMs);
                }
                else {
                    setTimeout(() => resolve(), timeoutMs);
                }
            });
            return d.getDevices();
        }
        finally {
            d.stop();
        }
    }
    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------
    handleService(svc) {
        const txt = normaliseTxt(svc.txt);
        if (!matchesIdentifier(svc, txt, this.identifier)) {
            this.logger.debug(`Skipping non-BK215 service: ${svc.name}`);
            return;
        }
        const addresses = Array.isArray(svc.addresses)
            ? svc.addresses.filter((a) => typeof a === "string")
            : [];
        const ipv4 = addresses.find(isIpv4) ?? addresses[0] ?? "";
        const device = {
            address: ipv4,
            addresses,
            port: typeof svc.port === "number" ? svc.port : 0,
            host: svc.host ?? "",
            name: svc.name ?? "",
            txt,
            serial: extractSerial(svc.name, svc.host, txt),
            firmware: txt.fw_ver ?? txt.fw ?? "",
        };
        // Deduplicate by serial+address — devices typically re-announce.
        const key = `${device.serial}|${device.address}`;
        if (this.seen.has(key)) {
            return;
        }
        this.seen.set(key, device);
        this.logger.info(`BK215 discovered: ${device.address}:${device.port} (serial=${device.serial || "unknown"}, fw=${device.firmware || "unknown"})`);
        this.emit("found", device);
    }
}
exports.BK215Discovery = BK215Discovery;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaultBonjourFactory() {
    // Lazy-require so tests can run without the native dependency present.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("bonjour-service");
    return new mod.Bonjour();
}
function silentLogger() {
    return {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
    };
}
function normaliseTxt(raw) {
    if (!raw || typeof raw !== "object") {
        return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (v === null || v === undefined) {
            continue;
        }
        if (Buffer.isBuffer(v)) {
            out[k.toLowerCase()] = v.toString("utf8");
        }
        else if (typeof v === "string") {
            out[k.toLowerCase()] = v;
        }
        else if (typeof v === "number" || typeof v === "boolean") {
            out[k.toLowerCase()] = String(v);
        }
        else {
            // Avoid '[object Object]' for arrays/objects: serialise instead.
            out[k.toLowerCase()] = JSON.stringify(v);
        }
    }
    return out;
}
function matchesIdentifier(svc, txt, identifier) {
    const id = identifier.toLowerCase();
    const haystacks = [
        svc.name?.toLowerCase() ?? "",
        svc.host?.toLowerCase() ?? "",
        txt.id?.toLowerCase() ?? "",
        txt.model?.toLowerCase() ?? "",
    ];
    return haystacks.some((h) => h.includes(id));
}
function extractSerial(name, host, txt) {
    // 1) Explicit TXT field wins.
    if (txt.sn) {
        return txt.sn;
    }
    if (txt.serial) {
        return txt.serial;
    }
    // 2) Try to pull a 8+ char alphanumeric token out of the name or host.
    const hay = `${name ?? ""} ${host ?? ""}`;
    const m = hay.match(/[A-Z0-9]{8,}/i);
    return m ? m[0] : "";
}
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
function isIpv4(addr) {
    return IPV4_RE.test(addr);
}
