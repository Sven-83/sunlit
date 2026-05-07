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
import { EventEmitter } from "node:events";
export interface DiscoveredDevice {
    /** Best-guess IPv4 address (the first IPv4 in the advertisement). */
    address: string;
    /** All advertised addresses (IPv4 + IPv6). */
    addresses: string[];
    /** The advertised port (always 8000 in practice). */
    port: number;
    /** Hostname / FQDN as advertised. */
    host: string;
    /** Service name as advertised (often contains the serial number). */
    name: string;
    /** TXT record as a flat object, if any was advertised. */
    txt: Record<string, string>;
    /** Best-guess serial number — extracted from name/host/TXT. May be empty. */
    serial: string;
    /** Best-guess firmware version — extracted from TXT. May be empty. */
    firmware: string;
}
/**
 * Minimal subset of `bonjour-service` we use, so tests can substitute a stub.
 */
export interface BonjourBrowserLike extends EventEmitter {
    stop(): void;
}
export interface BonjourLike {
    find(opts: {
        type: string;
        protocol?: "tcp" | "udp";
    }, onUp?: (svc: BonjourServiceLike) => void): BonjourBrowserLike;
    destroy(callback?: () => void): void;
}
/** Subset of a bonjour-service `Service` advertisement we read. */
export interface BonjourServiceLike {
    name: string;
    type: string;
    host: string;
    port: number;
    addresses?: string[];
    txt?: Record<string, unknown> | undefined;
}
export interface DiscoveryLogger {
    debug(m: string): void;
    info(m: string): void;
    warn(m: string): void;
}
export interface DiscoveryOptions {
    /** Factory creating a Bonjour instance. Defaults to a real one. */
    bonjourFactory?: () => BonjourLike;
    logger?: DiscoveryLogger;
    /** Override the device identifier filter (mostly for tests). */
    identifier?: string;
}
/**
 * Live mDNS browser. `start()` begins listening; `stop()` releases sockets.
 * Emits a 'found' event for every BK215 advertisement that matches the
 * identifier filter.
 */
export declare class BK215Discovery extends EventEmitter {
    private readonly bonjourFactory;
    private readonly logger;
    private readonly identifier;
    private bonjour;
    private browser;
    private readonly seen;
    constructor(opts?: DiscoveryOptions);
    /** Begin browsing. Idempotent. */
    start(): void;
    /** Stop browsing and release the underlying socket(s). Idempotent. */
    stop(): void;
    /** Snapshot of devices seen so far. */
    getDevices(): DiscoveredDevice[];
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
    static scanOnce(timeoutMs: number, opts?: DiscoveryOptions, timerService?: {
        setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
        clearTimeout(handle: NodeJS.Timeout): void;
    }): Promise<DiscoveredDevice[]>;
    private handleService;
}
