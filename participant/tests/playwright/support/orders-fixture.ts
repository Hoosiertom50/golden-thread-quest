import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";

// The per-test helper for tests that create saved orders (the data-isolation quest). It gives each
// test:
//   - uniqueName(): "Test User <run marker>-<code>", for example "Test User qa-0d4f2a-7k2m". The run
//     marker is shared by the whole run (global-setup.ts); the code is new for every call, so no
//     two tests, runs or testers can end up with the same name.
//   - create(): saves an order through the orders service (quick setup when the test is not about
//     saving) and notes its id.
//   - trackSavedBy(name): for a test that saved through the screen, finds that order's id and notes
//     it.
// After every test, whether it passed or failed, it cancels exactly the ids it noted, and nothing
// else. An order that's already gone (the test cancelled it itself) is fine.

export type SavedOrder = { id: string; name: string; event: string; quantity: number };

export function runMarker(): string {
  const marker = process.env.TIXLY_RUN_MARKER ?? "";
  if (!/^qa-[0-9a-f]{6}$/.test(marker)) {
    throw new Error("No run marker: run the tests with npx playwright test, which sets one up first.");
  }
  return marker;
}

class TestOrders {
  private readonly created: string[] = [];

  constructor(private readonly request: APIRequestContext) {}

  uniqueName(): string {
    return `Test User ${runMarker()}-${randomBytes(2).toString("hex")}`;
  }

  async create(order: Partial<Omit<SavedOrder, "id">> = {}): Promise<SavedOrder> {
    const answer = await this.request.post("/api/orders", {
      data: { name: this.uniqueName(), event: "spring-concert", quantity: 2, ...order },
    });
    expect(answer.status(), "the orders service saved the order").toBe(201);
    const saved = (await answer.json()) as SavedOrder;
    this.created.push(saved.id);
    return saved;
  }

  async trackSavedBy(name: string): Promise<void> {
    let id: string | undefined;
    await expect
      .poll(async () => {
        const all = (await (await this.request.get("/api/orders")).json()) as SavedOrder[];
        const mine = all.filter((order) => order.name === name);
        id = mine.length === 1 ? mine[0].id : undefined;
        return mine.length;
      }, { message: `exactly one saved order named ${name}` })
      .toBe(1);
    if (id) this.created.push(id);
  }

  async cleanUp(): Promise<void> {
    const problems: string[] = [];
    for (const id of this.created) {
      const answer = await this.request.delete(`/api/orders/${encodeURIComponent(id)}`);
      if (answer.status() !== 200 && answer.status() !== 404) {
        problems.push(`${id}: ${answer.status()}`);
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
