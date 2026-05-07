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

import { MDNS_DEVICE_IDENTIFIER, MDNS_SERVICE_TYPE } from "./bk215-protocol";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

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
  find(
    opts: { type: string; protocol?: "tcp" | "udp" },
    onUp?: (svc: BonjourServiceLike) => void,
  ): BonjourBrowserLike;
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Live mDNS browser. `start()` begins listening; `stop()` releases sockets.
 * Emits a 'found' event for every BK215 advertisement that matches the
 * identifier filter.
 */
export class BK215Discovery extends EventEmitter {
  private readonly bonjourFactory: () => BonjourLike;
  private readonly logger: DiscoveryLogger;
  private readonly identifier: string;

  private bonjour: BonjourLike | null = null;
  private browser: BonjourBrowserLike | null = null;
  private readonly seen = new Map<string, DiscoveredDevice>();

  public constructor(opts: DiscoveryOptions = {}) {
    super();
    this.bonjourFactory = opts.bonjourFactory ?? defaultBonjourFactory;
    this.logger = opts.logger ?? silentLogger();
    this.identifier = opts.identifier ?? MDNS_DEVICE_IDENTIFIER;
  }

  /** Begin browsing. Idempotent. */
  public start(): void {
    if (this.browser) {
      return;
    }
    this.bonjour = this.bonjourFactory();
    this.browser = this.bonjour.find(
      { type: MDNS_SERVICE_TYPE, protocol: "tcp" },
      (svc) => {
        this.handleService(svc);
      },
    );
    this.logger.debug(
      `mDNS browsing for _${MDNS_SERVICE_TYPE}._tcp (filter: "${this.identifier}")`,
    );
  }

  /** Stop browsing and release the underlying socket(s). Idempotent. */
  public stop(): void {
    if (this.browser) {
      try {
        this.browser.stop();
      } catch (err) {
        this.logger.warn(`Browser stop failed: ${(err as Error).message}`);
      }
      this.browser = null;
    }
    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch (err) {
        this.logger.warn(`Bonjour destroy failed: ${(err as Error).message}`);
      }
      this.bonjour = null;
    }
    this.seen.clear();
  }

  /** Snapshot of devices seen so far. */
  public getDevices(): DiscoveredDevice[] {
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
  public static async scanOnce(
    timeoutMs: number,
    opts: DiscoveryOptions = {},
    timerService?: {
      setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
      clearTimeout(handle: NodeJS.Timeout): void;
    },
  ): Promise<DiscoveredDevice[]> {
    const d = new BK215Discovery(opts);
    d.start();
    try {
      await new Promise<void>((resolve) => {
        if (timerService) {
          timerService.setTimeout(() => resolve(), timeoutMs);
        } else {
          setTimeout(() => resolve(), timeoutMs);
        }
      });
      return d.getDevices();
    } finally {
      d.stop();
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private handleService(svc: BonjourServiceLike): void {
    const txt = normaliseTxt(svc.txt);
    if (!matchesIdentifier(svc, txt, this.identifier)) {
      this.logger.debug(`Skipping non-BK215 service: ${svc.name}`);
      return;
    }

    const addresses = Array.isArray(svc.addresses)
      ? svc.addresses.filter((a) => typeof a === "string")
      : [];
    const ipv4 = addresses.find(isIpv4) ?? addresses[0] ?? "";

    const device: DiscoveredDevice = {
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

    this.logger.info(
      `BK215 discovered: ${device.address}:${device.port} (serial=${device.serial || "unknown"}, fw=${device.firmware || "unknown"})`,
    );
    this.emit("found", device);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultBonjourFactory(): BonjourLike {
  // Lazy-require so tests can run without the native dependency present.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("bonjour-service") as { Bonjour: new () => BonjourLike };
  return new mod.Bonjour();
}

function silentLogger(): DiscoveryLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
}

function normaliseTxt(
  raw: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) {
      continue;
    }
    if (Buffer.isBuffer(v)) {
      out[k.toLowerCase()] = v.toString("utf8");
    } else if (typeof v === "string") {
      out[k.toLowerCase()] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k.toLowerCase()] = String(v);
    } else {
      // Avoid '[object Object]' for arrays/objects: serialise instead.
      out[k.toLowerCase()] = JSON.stringify(v);
    }
  }
  return out;
}

function matchesIdentifier(
  svc: BonjourServiceLike,
  txt: Record<string, string>,
  identifier: string,
): boolean {
  const id = identifier.toLowerCase();
  const haystacks = [
    svc.name?.toLowerCase() ?? "",
    svc.host?.toLowerCase() ?? "",
    txt.id?.toLowerCase() ?? "",
    txt.model?.toLowerCase() ?? "",
  ];
  return haystacks.some((h) => h.includes(id));
}

function extractSerial(
  name: string | undefined,
  host: string | undefined,
  txt: Record<string, string>,
): string {
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
function isIpv4(addr: string): boolean {
  return IPV4_RE.test(addr);
}
