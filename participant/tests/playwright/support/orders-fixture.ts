import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";

// The per-test helper for tests that create saved orders (the data-isolation quest). It gives each
// test:
//   - uniqueName(): "Test User <run marker>-<code>", for example "Test User qa-1a2b3c4d-5e6f7a8b". The run
//     marker is shared by the whole run (global-setup.ts); the code is new for every call, so no
//     two tests, runs or testers can end up with the same name.
//   - create(): saves an order through the orders service (quick setup when the test is not about
//     saving) and notes its id.
//   - trackSavedBy(name): for a test that saved through the screen, finds that order's id and notes
//     it. Only a name this helper gave out (uniqueName) is accepted, and never an order that existed
//     before the run (TIXLY_PREEXISTING_IDS), so a mistake in a test can't make cleanup cancel
//     someone else's order.
// After every test, whether it passed or failed, it cancels exactly the ids it noted, and nothing
// else. An order that's already gone (the test cancelled it itself) is fine.

export type SavedOrder = { id: string; name: string; event: string; quantity: number };

export function runMarker(): string {
  const marker = process.env.TIXLY_RUN_MARKER ?? "";
  if (!/^qa-[0-9a-f]{8}$/.test(marker)) {
    throw new Error("No run marker: run the tests with npx playwright test, which sets one up first.");
  }
  return marker;
}

// The orders that existed before the run (noted by global-setup.ts): never noted for cleanup.
function preexistingIds(): Set<string> {
  try {
    return new Set(JSON.parse(process.env.TIXLY_PREEXISTING_IDS ?? "[]") as string[]);
  } catch {
    throw new Error("TIXLY_PREEXISTING_IDS isn't a list of order ids, so nothing can safely be noted for cleanup.");
  }
}

class TestOrders {
  private readonly created: string[] = [];
  private readonly issued = new Set<string>();
  private readonly request: APIRequestContext;

  // Written out in full (not as a constructor shorthand) so plain Node can load this file too, as
  // tools/run-in-order.ts does when it runs the safety net.
  constructor(request: APIRequestContext) {
    this.request = request;
  }

  uniqueName(): string {
    const name = `Test User ${runMarker()}-${randomBytes(4).toString("hex")}`;
    this.issued.add(name);
    return name;
  }

  // Notes an id for cleanup, unless it belongs to an order that existed before the run.
  private note(id: string): void {
    if (preexistingIds().has(id)) {
      throw new Error(`Order ${id} existed before this run; it is never noted for cleanup.`);
    }
    this.created.push(id);
  }

  // The name is always the generated, run-marked one (it can't be overridden), so even an order whose
  // save answer is lost can be found by the run-end safety net.
  async create(order: Partial<Omit<SavedOrder, "id" | "name">> = {}): Promise<SavedOrder> {
    const answer = await this.request.post("/api/orders", {
      data: { event: "spring-concert", quantity: 2, ...order, name: this.uniqueName() },
    });
    expect(answer.status(), "the orders service saved the order").toBe(201);
    const saved = (await answer.json()) as SavedOrder;
    this.note(saved.id);
    return saved;
  }

  async trackSavedBy(name: string): Promise<void> {
    if (!this.issued.has(name)) {
      throw new Error(`"${name}" wasn't made by this test's uniqueName(), so it can't be this test's order.`);
    }
    let id: string | undefined;
    await expect
      .poll(async () => {
        const all = (await (await this.request.get("/api/orders")).json()) as SavedOrder[];
        const mine = all.filter((order) => order.name === name);
        id = mine.length === 1 ? mine[0].id : undefined;
        return mine.length;
      }, { message: `exactly one saved order named ${name}` })
      .toBe(1);
    if (id) this.note(id);
  }

  // Every saved order, from the orders service.
  async list(): Promise<SavedOrder[]> {
    return (await (await this.request.get("/api/orders")).json()) as SavedOrder[];
  }

  async cleanUp(): Promise<void> {
    const problems: string[] = [];
    // Every noted order is tried, even if an earlier one fails; all failures are reported together.
    for (const id of this.created) {
      try {
        const answer = await this.request.delete(`/api/orders/${encodeURIComponent(id)}`);
        if (answer.status() !== 200 && answer.status() !== 404) problems.push(`${id}: ${answer.status()}`);
      } catch (problem) {
        problems.push(`${id}: ${problem instanceof Error ? problem.message : problem}`);
      }
    }
    if (problems.length > 0) throw new Error(`Cleanup couldn't cancel: ${problems.join(", ")}`);
  }
}

export const test = base.extend<{ orders: TestOrders }>({
  orders: async ({ request }, use) => {
    const orders = new TestOrders(request);
    // Everything after use() runs when the test ends, pass or fail.
    await use(orders);
    await orders.cleanUp();
  },
});

export { expect };
