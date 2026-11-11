// Runs once, before any test: picks this run's marker, which goes into the name of every order the
// isolated tests create (see orders-fixture.ts). Every test in the run, in every browser worker,
// shares it, because Playwright passes environment variables from here to the workers.
//
// A marker already set (TIXLY_RUN_MARKER, for example by tools/run-in-order.ts, which runs tests
// one at a time but as one run) is kept, so all of that run's data carries the same marker.

import { randomBytes } from "node:crypto";

export default function globalSetup(): void {
  const given = process.env.TIXLY_RUN_MARKER;
  if (given !== undefined && !/^qa-[0-9a-f]{6}$/.test(given)) {
    throw new Error(`TIXLY_RUN_MARKER must look like qa-1a2b3c, not "${given}"`);
  }
  process.env.TIXLY_RUN_MARKER = given ?? `qa-${randomBytes(3).toString("hex")}`;
}
