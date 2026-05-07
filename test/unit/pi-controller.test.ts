import { expect } from "chai";
import { PIController } from "../../src/lib/pi-controller";

const baseOpts = {
  kp: 0.7,
  ki: 0.05,
  outMin: 0,
  outMax: 800,
  deadbandW: 30,
  minChangeW: 5,
};

describe("PIController", () => {
  describe("input validation", () => {
    it("rejects non-positive kp", () => {
      expect(() => new PIController({ ...baseOpts, kp: 0 })).to.throw(
        RangeError,
      );
      expect(() => new PIController({ ...baseOpts, kp: -1 })).to.throw(
        RangeError,
      );
    });

    it("accepts ki = 0 (P-only mode)", () => {
      expect(() => new PIController({ ...baseOpts, ki: 0 })).to.not.throw();
    });

    it("rejects negative ki", () => {
      expect(() => new PIController({ ...baseOpts, ki: -0.01 })).to.throw(
        RangeError,
      );
    });

    it("rejects outMax ≤ outMin", () => {
      expect(
        () => new PIController({ ...baseOpts, outMin: 100, outMax: 100 }),
      ).to.throw(RangeError);
      expect(
        () => new PIController({ ...baseOpts, outMin: 200, outMax: 100 }),
      ).to.throw(RangeError);
    });

    it("rejects negative deadband", () => {
      expect(() => new PIController({ ...baseOpts, deadbandW: -1 })).to.throw(
        RangeError,
      );
    });

    it("rejects non-finite inputs in update()", () => {
      const c = new PIController(baseOpts);
      expect(() => c.update(Number.NaN, 0, 1)).to.throw(RangeError);
      expect(() => c.update(0, Number.POSITIVE_INFINITY, 1)).to.throw(
        RangeError,
      );
      expect(() => c.update(0, 0, 0)).to.throw(RangeError);
      expect(() => c.update(0, 0, -1)).to.throw(RangeError);
    });
  });

  describe("P-only behaviour (ki=0)", () => {
    it("output equals kp * error when not saturated and no deadband hit", () => {
      const c = new PIController({ ...baseOpts, ki: 0 });
      const r = c.update(200, 0, 1);
      expect(r.output).to.be.closeTo(140, 1e-9); // 0.7 * 200
      expect(r.error).to.equal(200);
      expect(r.integral).to.equal(0);
      expect(r.saturated).to.equal(false);
    });

    it("integral stays exactly zero across iterations", () => {
      const c = new PIController({ ...baseOpts, ki: 0 });
      c.update(100, 0, 1);
      c.update(100, 0, 1);
      const r = c.update(100, 0, 1);
      expect(r.integral).to.equal(0);
      expect(c.getIntegral()).to.equal(0);
    });
  });

  describe("integral accumulation", () => {
    it("eliminates steady-state error to within deadband", () => {
      // Plant model: every tick, the meter reads (load - output).
      // P-only would settle with constant offset; the integral pulls it to zero.
      const c = new PIController(baseOpts);
      const draw = 300; // constant load drawing 300 W
      const dt = 4;
      let appliedOutput = 0;

      // Generous iteration budget — Ki=0.05 and dt=4 give a slow but sure pull.
      let finalGrid = draw;
      for (let i = 0; i < 500; i++) {
        const grid = draw - appliedOutput;
        finalGrid = grid;
        const r = c.update(grid, 0, dt);
        appliedOutput = r.output;
      }

      // Steady-state error must be inside the deadband (the controller
      // mathematically cannot do better than that — by design).
      expect(Math.abs(finalGrid)).to.be.at.most(baseOpts.deadbandW);
    });

    it("integral grows monotonically when error is constant and output is unsaturated", () => {
      const c = new PIController(baseOpts);
      const i0 = c.getIntegral();
      c.update(100, 0, 1);
      const i1 = c.getIntegral();
      c.update(100, 0, 1);
      const i2 = c.getIntegral();
      expect(i1).to.be.greaterThan(i0);
      expect(i2).to.be.greaterThan(i1);
    });
  });

  describe("deadband", () => {
    it("zeroes the error when |raw| ≤ deadbandW", () => {
      const c = new PIController(baseOpts);
      const r = c.update(20, 0, 1); // 20 < 30 deadband
      expect(r.error).to.equal(0);
      expect(r.output).to.equal(0); // P+I both zero
    });

    it("passes through full error when |raw| > deadbandW", () => {
      const c = new PIController(baseOpts);
      const r = c.update(31, 0, 1);
      expect(r.error).to.equal(31);
    });

    it("respects target offset", () => {
      const c = new PIController({ ...baseOpts, ki: 0 });
      const r = c.update(150, 100, 1); // raw err = 50, > deadband
      expect(r.error).to.equal(50);
      expect(r.output).to.be.closeTo(35, 1e-9); // 0.7 * 50
    });
  });

  describe("output saturation and anti-windup", () => {
    it("clamps output to outMax", () => {
      const c = new PIController({ ...baseOpts, ki: 0 });
      const r = c.update(5000, 0, 1); // P alone wants 3500 W
      expect(r.output).to.equal(800);
      expect(r.saturated).to.equal(true);
    });

    it("clamps output to outMin (0)", () => {
      const c = new PIController({ ...baseOpts, ki: 0 });
      const r = c.update(-5000, 0, 1);
      expect(r.output).to.equal(0);
      expect(r.saturated).to.equal(true);
    });

    it("freezes integral when saturated AND error pushes further into saturation", () => {
      const c = new PIController(baseOpts);
      // Drive into upper saturation 5 times; each time the P-term alone
      // already exceeds outMax, so the integral must NOT grow.
      for (let i = 0; i < 5; i++) {
        c.update(5000, 0, 1);
      }
      expect(c.getIntegral()).to.equal(0);
    });

    it("releases the integral once the output stops being saturated", () => {
      // Step 1: constant moderate error, output not saturated → integral grows.
      const c = new PIController({ ...baseOpts, ki: 0.5 });
      for (let i = 0; i < 5; i++) {
        c.update(100, 0, 1);
      }
      const wound = c.getIntegral();
      expect(wound).to.be.greaterThan(0);

      // Step 2: drive briefly into upper saturation. Integral should freeze.
      c.update(10_000, 0, 1);
      const afterSat = c.getIntegral();
      expect(afterSat).to.equal(wound);

      // Step 3: error reverses (negative). Output is no longer saturated,
      // so the integral can move freely — and decreases.
      c.update(-200, 0, 1);
      expect(c.getIntegral()).to.be.lessThan(afterSat);
    });

    it("hard-caps integral within ±outMax even on extreme drift", () => {
      const c = new PIController({ ...baseOpts, ki: 1.0 });
      for (let i = 0; i < 1000; i++) {
        c.update(50, 0, 10);
      } // small but constant
      expect(Math.abs(c.getIntegral())).to.be.at.most(baseOpts.outMax);
    });
  });

  describe("hysteresis (shouldSend)", () => {
    it("shouldSend = true on the very first call (no last-sent reference)", () => {
      const c = new PIController({ ...baseOpts, ki: 0 });
      const r = c.update(100, 0, 1);
      expect(r.shouldSend).to.equal(true);
    });

    it("shouldSend = false when |Δ| < minChangeW after markSent", () => {
      const c = new PIController({ ...baseOpts, ki: 0, minChangeW: 10 });
      const r1 = c.update(200, 0, 1); // 140 W
      c.markSent(r1.output);
      const r2 = c.update(205, 0, 1); // 143.5 W → Δ=3.5 < 10
      expect(r2.shouldSend).to.equal(false);
    });

    it("shouldSend = true when |Δ| ≥ minChangeW", () => {
      const c = new PIController({ ...baseOpts, ki: 0, minChangeW: 10 });
      const r1 = c.update(200, 0, 1);
      c.markSent(r1.output);
      const r2 = c.update(300, 0, 1); // big jump
      expect(r2.shouldSend).to.equal(true);
    });
  });

  describe("persistence", () => {
    it("restores integral across instantiation", () => {
      const c1 = new PIController(baseOpts);
      for (let i = 0; i < 3; i++) {
        c1.update(100, 0, 1);
      }
      const persisted = c1.getIntegral();

      const c2 = new PIController({ ...baseOpts, initialIntegral: persisted });
      expect(c2.getIntegral()).to.equal(persisted);
    });

    it("reset() clears integral and last output", () => {
      const c = new PIController(baseOpts);
      for (let i = 0; i < 5; i++) {
        c.update(100, 0, 1);
      }
      expect(c.getIntegral()).to.be.greaterThan(0);
      c.reset();
      expect(c.getIntegral()).to.equal(0);
      expect(c.getLastOutput()).to.equal(0);
    });
  });
});
