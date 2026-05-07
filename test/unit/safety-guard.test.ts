import { expect } from "chai";
import {
  evaluateSafety,
  type SafetyConfig,
  type SafetyInputs,
} from "../../src/lib/safety-guard";

const NOW = 1_700_000_000_000;

const cfg: SafetyConfig = {
  gridStaleTimeoutS: 15,
  bk215StaleTimeoutS: 60,
  socMin: 10,
  socMax: 90,
  socSafetyBufferPp: 3,
};

/** Base "everything healthy" input. Override fields per test. */
const healthy = (): SafetyInputs => ({
  bk215LinkOk: true,
  bk215LastDataMs: NOW - 5_000,
  soc: 50,
  localModeOn: true,
  gridLastUpdateMs: NOW - 2_000,
  gridPowerW: 100,
  nowMs: NOW,
});

describe("evaluateSafety", () => {
  it("allows when every check passes", () => {
    const v = evaluateSafety(healthy(), cfg);
    expect(v.kind).to.equal("allow");
  });

  describe("BK215 link", () => {
    it("forces safe when link is down", () => {
      const v = evaluateSafety({ ...healthy(), bk215LinkOk: false }, cfg);
      expect(v.kind).to.equal("force-safe");
      if (v.kind === "force-safe") {
        expect(v.reasonId).to.equal("bk215-link-down");
      }
    });

    it("forces safe when no data has ever arrived", () => {
      const v = evaluateSafety({ ...healthy(), bk215LastDataMs: null }, cfg);
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("bk215-data-stale");
    });

    it("forces safe when data is older than threshold", () => {
      const stale = { ...healthy(), bk215LastDataMs: NOW - 70_000 };
      const v = evaluateSafety(stale, cfg);
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("bk215-data-stale");
    });

    it("allows when data is exactly at the threshold edge", () => {
      const edge = {
        ...healthy(),
        bk215LastDataMs: NOW - cfg.bk215StaleTimeoutS * 1000,
      };
      const v = evaluateSafety(edge, cfg);
      expect(v.kind).to.equal("allow");
    });
  });

  describe("local mode", () => {
    it("forces safe when local mode is off", () => {
      const v = evaluateSafety({ ...healthy(), localModeOn: false }, cfg);
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("bk215-local-mode-off");
    });
  });

  describe("grid meter", () => {
    it("forces safe when no grid update has arrived", () => {
      const v = evaluateSafety({ ...healthy(), gridLastUpdateMs: null }, cfg);
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("grid-data-missing");
    });

    it("forces safe when gridPowerW is null", () => {
      const v = evaluateSafety({ ...healthy(), gridPowerW: null }, cfg);
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("grid-data-missing");
    });

    it("forces safe when grid is stale", () => {
      const v = evaluateSafety(
        { ...healthy(), gridLastUpdateMs: NOW - 30_000 },
        cfg,
      );
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("grid-data-stale");
    });
  });

  describe("SoC", () => {
    it("forces safe when SoC is unknown", () => {
      const v = evaluateSafety({ ...healthy(), soc: null }, cfg);
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("soc-unknown");
    });

    it("forces safe just below the safety floor (min + buffer)", () => {
      // socMin=10, buffer=3 → effective floor=13. SoC=12 must trip.
      const v = evaluateSafety({ ...healthy(), soc: 12 }, cfg);
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("soc-below-min");
    });

    it("allows exactly at the safety floor", () => {
      const v = evaluateSafety({ ...healthy(), soc: 13 }, cfg);
      expect(v.kind).to.equal("allow");
    });

    it("forces safe above the ceiling", () => {
      const v = evaluateSafety({ ...healthy(), soc: 95 }, cfg);
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("soc-above-max");
    });
  });

  describe("check ordering", () => {
    it("reports the most fundamental failure first", () => {
      // Multiple things wrong: link down AND SoC bad. Link must win.
      const v = evaluateSafety(
        { ...healthy(), bk215LinkOk: false, soc: 5 },
        cfg,
      );
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("bk215-link-down");
    });

    it("reports grid issue before SoC issue", () => {
      const v = evaluateSafety(
        { ...healthy(), gridLastUpdateMs: null, soc: 5 },
        cfg,
      );
      if (v.kind !== "force-safe") {
        throw new Error("expected force-safe");
      }
      expect(v.reasonId).to.equal("grid-data-missing");
    });
  });
});
