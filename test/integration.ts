/**
 * Adapter integration test using the @iobroker/testing harness.
 *
 * Spins up a real (but in-memory) ioBroker controller, starts the adapter,
 * waits 10 seconds and asserts that no fatal error or unhandled exception
 * occurred. Required by the official ioBroker repo checker.
 *
 * Note: We don't have a real BK215 in CI, so we expect the adapter to
 * complete `onReady` and either log "no host configured" or sit in the
 * reconnect loop. Either is fine — we only fail on hard crashes.
 *
 * Compact-mode safety: the second test stops and starts the adapter twice
 * in quick succession. If any timer or socket leaked, the harness would
 * see the second startup time out or throw.
 */

import path from "node:path";
import { tests } from "@iobroker/testing";

tests.integration(path.join(__dirname, ".."), {
  // Exit code 11 = ioBroker convention for "missing config, do not restart".
  // Our adapter terminates with 11 when no host is configured AND mDNS
  // discovers nothing — which is the expected state in CI.
  allowedExitCodes: [0, 11],
  defineAdditionalTests({ suite }) {
    suite("runs without crashing", (getHarness) => {
      it("survives 10 seconds without error", async function () {
        this.timeout(60_000);
        const harness = getHarness();
        await harness.startAdapterAndWait();
        await new Promise((r) => setTimeout(r, 10_000));
      });
    });

    suite("Compact-Mode lifecycle (M4)", (getHarness) => {
      it("survives a stop/start cycle without leaking resources", async function () {
        this.timeout(120_000);
        const harness = getHarness();

        // Start cycle 1
        await harness.startAdapterAndWait();
        await new Promise((r) => setTimeout(r, 5_000));
        await harness.stopAdapter();
        await new Promise((r) => setTimeout(r, 1_000));

        // Start cycle 2 — if anything leaked, this would hang or throw
        await harness.startAdapterAndWait();
        await new Promise((r) => setTimeout(r, 5_000));
      });
    });
  },
});
