import { EventEmitter } from "node:events";
import { expect } from "chai";

import {
  BK215Discovery,
  type BonjourBrowserLike,
  type BonjourLike,
  type BonjourServiceLike,
  type DiscoveredDevice,
} from "../../src/lib/bk215-discovery";

class MockBrowser extends EventEmitter implements BonjourBrowserLike {
  public stopped = false;
  public stop(): void {
    this.stopped = true;
  }
}

class MockBonjour implements BonjourLike {
  public browser: MockBrowser | null = null;
  public destroyed = false;
  /** Captured callback so tests can fire services into the discovery. */
  public onUp: ((svc: BonjourServiceLike) => void) | null = null;

  public find(
    _opts: { type: string; protocol?: "tcp" | "udp" },
    onUp?: (svc: BonjourServiceLike) => void,
  ): BonjourBrowserLike {
    this.browser = new MockBrowser();
    this.onUp = onUp ?? null;
    return this.browser;
  }

  public destroy(): void {
    this.destroyed = true;
  }
}

describe("BK215Discovery", () => {
  let mock: MockBonjour;
  let disc: BK215Discovery;
  let found: DiscoveredDevice[];

  beforeEach(() => {
    mock = new MockBonjour();
    disc = new BK215Discovery({ bonjourFactory: () => mock });
    found = [];
    disc.on("found", (d: DiscoveredDevice) => found.push(d));
  });

  afterEach(() => {
    disc.stop();
  });

  it("start() creates a Bonjour browser", () => {
    disc.start();
    expect(mock.browser).to.not.equal(null);
    expect(mock.onUp).to.be.a("function");
  });

  it("start() is idempotent", () => {
    disc.start();
    const first = mock.browser;
    disc.start();
    expect(mock.browser).to.equal(first);
  });

  it("matches by identifier in service name", () => {
    disc.start();
    mock.onUp!({
      name: "hp-bk215-AB1234",
      type: "http",
      host: "something.local",
      port: 8000,
      addresses: ["192.168.0.42"],
    });
    expect(found).to.have.length(1);
    expect(found[0].address).to.equal("192.168.0.42");
  });

  it("matches by identifier in host", () => {
    disc.start();
    mock.onUp!({
      name: "BatteryStorage",
      type: "http",
      host: "hp-bk215-XYZ.local",
      port: 8000,
      addresses: ["192.168.0.43"],
    });
    expect(found).to.have.length(1);
  });

  it("matches by identifier in TXT record (model field)", () => {
    disc.start();
    mock.onUp!({
      name: "Generic",
      type: "http",
      host: "unknown.local",
      port: 8000,
      addresses: ["192.168.0.44"],
      txt: { model: "HP-BK215" },
    });
    expect(found).to.have.length(1);
  });

  it("ignores services that do not match the identifier", () => {
    disc.start();
    mock.onUp!({
      name: "FritzBox",
      type: "http",
      host: "fritz.box",
      port: 80,
      addresses: ["192.168.0.1"],
    });
    mock.onUp!({
      name: "Some Printer",
      type: "http",
      host: "printer.local",
      port: 631,
      addresses: ["192.168.0.50"],
      txt: { product: "HP LaserJet" },
    });
    expect(found).to.have.length(0);
  });

  it("deduplicates the same device on repeated announcements", () => {
    disc.start();
    const svc: BonjourServiceLike = {
      name: "hp-bk215-AB1234",
      type: "http",
      host: "bk215.local",
      port: 8000,
      addresses: ["192.168.0.42"],
    };
    mock.onUp!(svc);
    mock.onUp!(svc);
    mock.onUp!(svc);
    expect(found).to.have.length(1);
  });

  it("treats different addresses as different devices", () => {
    disc.start();
    mock.onUp!({
      name: "hp-bk215-AB1234",
      type: "http",
      host: "bk215-a.local",
      port: 8000,
      addresses: ["192.168.0.42"],
    });
    mock.onUp!({
      name: "hp-bk215-CD5678",
      type: "http",
      host: "bk215-b.local",
      port: 8000,
      addresses: ["192.168.0.43"],
    });
    expect(found).to.have.length(2);
  });

  it("prefers an IPv4 address over IPv6", () => {
    disc.start();
    mock.onUp!({
      name: "hp-bk215-AB1234",
      type: "http",
      host: "bk215.local",
      port: 8000,
      addresses: ["fe80::1", "192.168.0.42", "::1"],
    });
    expect(found[0].address).to.equal("192.168.0.42");
    expect(found[0].addresses).to.deep.equal([
      "fe80::1",
      "192.168.0.42",
      "::1",
    ]);
  });

  it("extracts serial from TXT.sn when present", () => {
    disc.start();
    mock.onUp!({
      name: "hp-bk215",
      type: "http",
      host: "bk215.local",
      port: 8000,
      addresses: ["192.168.0.42"],
      txt: { sn: "SN12345678", fw_ver: "1.5.7" },
    });
    expect(found[0].serial).to.equal("SN12345678");
    expect(found[0].firmware).to.equal("1.5.7");
  });

  it("falls back to extracting serial from the service name", () => {
    disc.start();
    mock.onUp!({
      name: "hp-bk215-ABCD12345",
      type: "http",
      host: "bk215.local",
      port: 8000,
      addresses: ["192.168.0.42"],
    });
    // The 8+ alphanumeric token in the name should be picked up.
    expect(found[0].serial).to.match(/[A-Z0-9]{8,}/i);
  });

  it("normalises Buffer-valued TXT fields to strings", () => {
    disc.start();
    mock.onUp!({
      name: "hp-bk215",
      type: "http",
      host: "bk215.local",
      port: 8000,
      addresses: ["192.168.0.42"],
      txt: {
        fw_ver: Buffer.from("4.0.3", "utf8"),
        model: Buffer.from("HP-BK215", "utf8"),
      },
    });
    expect(found[0].firmware).to.equal("4.0.3");
  });

  it("stop() halts the browser and destroys Bonjour", () => {
    disc.start();
    const browser = mock.browser!;
    disc.stop();
    expect(browser.stopped).to.equal(true);
    expect(mock.destroyed).to.equal(true);
  });

  it("stop() is idempotent", () => {
    disc.start();
    disc.stop();
    expect(() => disc.stop()).to.not.throw();
  });

  it("stop() clears the seen-devices cache", () => {
    disc.start();
    mock.onUp!({
      name: "hp-bk215-AB1234",
      type: "http",
      host: "bk215.local",
      port: 8000,
      addresses: ["192.168.0.42"],
    });
    expect(disc.getDevices()).to.have.length(1);
    disc.stop();
    expect(disc.getDevices()).to.have.length(0);
  });

  describe("scanOnce", () => {
    it("returns devices found within the timeout window", async () => {
      // Build a mock that emits one device immediately when find() is called.
      const m = new MockBonjour();
      const factory = (): BonjourLike => m;

      const promise = BK215Discovery.scanOnce(50, { bonjourFactory: factory });
      // Wait for find() to wire up onUp, then push a device.
      await new Promise((r) => setImmediate(r));
      m.onUp!({
        name: "hp-bk215-AB1234",
        type: "http",
        host: "bk215.local",
        port: 8000,
        addresses: ["192.168.0.42"],
      });
      const result = await promise;
      expect(result).to.have.length(1);
      expect(result[0].address).to.equal("192.168.0.42");
      expect(m.destroyed).to.equal(true);
    });

    it("returns an empty array when nothing matches within the timeout", async () => {
      const m = new MockBonjour();
      const result = await BK215Discovery.scanOnce(20, {
        bonjourFactory: () => m,
      });
      expect(result).to.deep.equal([]);
    });
  });
});
