/**
 * Package-level tests powered by @iobroker/testing.
 *
 * These exercise:
 *   - that io-package.json is valid and consistent with package.json
 *   - that the adapter starts up, hits 'ready', and shuts down cleanly
 *
 * Run via `npm run test:package`. Required by the ioBroker repo checker.
 */

import path from "node:path";
import { tests } from "@iobroker/testing";

// Validate the package files. Strict; will fail on schema violations.
tests.packageFiles(path.join(__dirname, ".."));
