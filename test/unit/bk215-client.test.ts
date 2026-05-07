import { EventEmitter } from "node:events";
import { expect } from "chai";

import { BK215Client, type SocketLike } from "../../src/lib/bk215-client";

/**
 * Minimal in-memory stand-in for `node:net`.Socket that satisfies the
 * `SocketLike` interface that BK215Client requires.
 *
 * Test helpers:
 *   - `pushAscii(text)` simulates inbound bytes from the device.
 *   - `written` is the list of every payload that was sent.
 *   - `destroyed` reflects whether destroy() was called.
 */
class MockSocket extends EventEmitter implements SocketLike {
  public written: string[] = [];
  public destroyed = false;
  public connectArgs: { host: string; port: number } | null = null;

  public setNoDelay(_noDelay: boolean): void {
    /* no-op */
  }

  public connect(opts: { host: string; port: number }): this {
    this.connectArgs = opts;
    // Simulate immediate successful TCP connect.
    setImmediate(() => this.emit("connect"));
    return this;
  }

  public write(
    data: string,
    _encoding: "ascii",
    cb?: (err?: Error) => void,
  ): boolean {
    this.written.push(data);
    if (cb) {
      cb();
    }
    return true;
  }

  public destroy(err?: Error): this {
    this.destroyed = true;
    setImmediate(() => this.emit("close", !!err));
    return this;
  }

  public override removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }

  /**
   * Test-only: push raw bytes from the simulated device.
   *
   * @param payload
   */
  public pushAscii(payload: string): void {
    this.emit("data", Buffer.from(payload, "ascii"));
  }
}

/** Wait one event-loop tick — enough for setImmediate-scheduled events to fire. */
const nextTick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("BK215Client (with mock socket)", () => {
  let mock: MockSocket;
  let client: BK215Client;

  beforeEach(async () => {
    mock = new MockSocket();
    client = new BK215Client({
      host: "192.168.0.42",
      port: 8000,
      responseTimeoutMs: 200,
      idleTimeoutMs: 60_000,
      socketFactory: () => mock,
    });
    client.on("error", () => {
      /* swallow non-fatal errors in tests */
    });
    await client.connect(); // resolves once the mock fires 'connect' and the client emits 'open'
  });

  afterEach(async () => {
    await client.destroy();
  });

  describe("handshake", () => {
    it("connects to the configured host:port", () => {
      expect(mock.connectArgs).to.deep.equal({
        host: "192.168.0.42",
        port: 8000,
      });
    });

    it("writes the documented handshake frame", () => {
      expect(mock.written).to.have.length(1);
      // {"code":24658,"data":{}} terminated by CRLF (per protocol).
      expect(mock.written[0]).to.match(/^\{"code":24658,"data":\{\}\}\r\n$/);
    });

    it("reports isOpen() === true after handshake", () => {
      expect(client.isOpen()).to.equal(true);
    });
  });

  describe("status reports", () => {
    it('emits "data" events with the merged status', async () => {
      const seen: Array<Record<string, number>> = [];
      client.on("data", (s) => seen.push({ ...s }));

      mock.pushAscii('{"code":24658,"data":{"t211":67,"t590":300}}\r\n');
      mock.pushAscii('{"code":24658,"data":{"t702_1":1}}\r\n');
      await nextTick();

      expect(seen).to.have.length(2);
      // Second snapshot is merged from both reports.
      expect(seen[1]).to.include({ t211: 67, t590: 300, t702_1: 1 });
    });

    it("treats the -1 sentinel as a deletion, not as a real reading", async () => {
      mock.pushAscii('{"code":24658,"data":{"t211":67,"t590":300}}\r\n');
      mock.pushAscii('{"code":24658,"data":{"t590":-1}}\r\n');
      await nextTick();

      const status = client.getStatus();
      expect(status.t211).to.equal(67);
      expect(status.t590).to.be.undefined;
    });
  });

  describe("sendCommand", () => {
    it("rejects out-of-range values before they hit the wire", async () => {
      const before = mock.written.length;
      try {
        await client.setChargingPower(99_999);
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).name).to.equal("RangeError");
      }
      // Nothing additional was written.
      expect(mock.written.length).to.equal(before);
    });

    it("writes a SET frame and resolves on positive ACK", async () => {
      const promise = client.setChargingPower(450);
      // Simulate the device replying with success.
      await nextTick();
      mock.pushAscii('{"code":24663,"data":{"t590":0}}');
      await promise; // should not throw

      const last = mock.written[mock.written.length - 1];
      expect(last).to.match(/"code":24662/);
      expect(last).to.match(/"t590":450/);
    });

    it("rejects with BK215CommandError on negative ACK", async () => {
      const promise = client.setChargingPower(450);
      await nextTick();
      mock.pushAscii('{"code":24663,"data":{"t590":-1}}');

      try {
        await promise;
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).name).to.equal("BK215CommandError");
        expect((err as Error & { errorCode: number }).errorCode).to.equal(-1);
      }
    });

    it("rejects with BK215TimeoutError if no ACK arrives", async () => {
      try {
        await client.setChargingPower(450);
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).name).to.equal("BK215TimeoutError");
      }
    }).timeout(2_000);

    it("serialises commands so a second one waits for the first ACK", async () => {
      // Fire two commands in parallel.
      const p1 = client.setChargingPower(100);
      const p2 = client.setChargingPower(200);
      await nextTick();

      // Only the FIRST command should have been written so far.
      // (Index 0 was the handshake; index 1 should be the first SET; nothing more yet.)
      expect(mock.written.length).to.equal(2);
      expect(mock.written[1]).to.match(/"t590":100/);

      // ACK the first.
      mock.pushAscii('{"code":24663,"data":{"t590":0}}');
      await p1;
      await nextTick();

      // Now the second command should have hit the wire.
      expect(mock.written.length).to.equal(3);
      expect(mock.written[2]).to.match(/"t590":200/);

      // ACK the second.
      mock.pushAscii('{"code":24663,"data":{"t590":0}}');
      await p2;
    });
  });

  describe("convenience wrappers", () => {
    it("enableHomeApplianceMode writes t702_1=1", async () => {
      const promise = client.enableHomeApplianceMode();
      await nextTick();
      mock.pushAscii('{"code":24663,"data":{"t702_1":0}}');
      await promise;

      const last = mock.written[mock.written.length - 1];
      expect(last).to.match(/"t702_1":1/);
    });

    it("enableLocalMode writes t598=1", async () => {
      const promise = client.enableLocalMode();
      await nextTick();
      mock.pushAscii('{"code":24663,"data":{"t598":0}}');
      await promise;

      const last = mock.written[mock.written.length - 1];
      expect(last).to.match(/"t598":1/);
    });

    it("rounds non-integer power values", async () => {
      const promise = client.setChargingPower(123.7);
      await nextTick();
      mock.pushAscii('{"code":24663,"data":{"t590":0}}');
      await promise;

      const last = mock.written[mock.written.length - 1];
      expect(last).to.match(/"t590":124/);
    });
  });

  describe("lifecycle", () => {
    it("destroy() closes the socket and rejects pending commands", async () => {
      const promise = client.setChargingPower(450);
      await nextTick();
      // Don't ACK — destroy mid-flight.
      await client.destroy();

      try {
        await promise;
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.match(/destroyed|closed/i);
      }
      expect(mock.destroyed).to.equal(true);
    });
  });
});
