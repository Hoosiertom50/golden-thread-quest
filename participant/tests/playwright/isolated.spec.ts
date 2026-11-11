import { expect, test } from "./support/orders-fixture.ts";

// The ISOLATED version of coupled.spec.ts, for the data-isolation quest: the same two stories, but
// each test creates the order it needs, with a name no other test, run or tester can share, and
// the orders helper cancels exactly what the test created when it ends, whether it passed or
// failed. Neither test relies on the other, so they pass in any order and in parallel.
//
// Names look like "Test User qa-1a2b3c4d-5e6f7a8b": "qa-1a2b3c4d" marks this run, "5e6f7a8b" this order.

test(
  "a buyer saves an order and sees it in Your orders (isolated)",
  { tag: ["@data-isolated", "@risk-medium", "@writes-data", "@fast"] },
  async ({ page, orders }) => {
    const name = orders.uniqueName();
    await page.goto("/review?event=spring-concert&quantity=2");
    await page.getByLabel("Your name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Save order", exact: true }).click();
    // Note the saved order straight away, so it's cleaned up even if a check below fails.
    await orders.trackSavedBy(name);
    await page.getByRole("link", { name: "See your orders", exact: true }).click();

    await expect(page.getByRole("button", { name: `Cancel order for ${name}`, exact: true })).toBeVisible();
    // The saved order is the one reviewed: 2 tickets, $55.00.
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
    await expect(row.getByRole("cell")).toHaveText([name, "Spring Concert", "2", "$55.00", "Cancel order"]);
  },
);

test(
  "a buyer cancels their own order (isolated: makes the order it cancels)",
  { tag: ["@data-isolated", "@risk-medium", "@writes-data", "@fast"] },
  async ({ page, orders }) => {
    // Setup through the orders service: this test is about cancelling, not saving.
    const order = await orders.create({ quantity: 1 });
    await page.goto("/orders");

    await page.getByRole("button", { name: `Cancel order for ${order.name}`, exact: true }).click();

    await expect(page.getByText(`Order for ${order.name} cancelled.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Cancel order for ${order.name}`, exact: true })).toHaveCount(0);
  },
);

test(
  "cancelling one buyer's order leaves another buyer's order in Your orders (isolated)",
  { tag: ["@data-isolated", "@risk-medium", "@writes-data", "@fast"] },
  async ({ page, orders }) => {
    // Two orders of its own: one to cancel, one that must survive.
    const toCancel = await orders.create({ quantity: 1 });
    const toKeep = await orders.create({ quantity: 3 });
    // This page sees only this test's two orders (the real list from the server, filtered), so the
    // order to keep sits right below the one to cancel however many other tests save at the same time.
    await page.route("**/api/orders", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const answer = await route.fetch();
      const all = (await answer.json()) as { id: string }[];
      await route.fulfill({ response: answer, json: all.filter((order) => order.id === toCancel.id || order.id === toKeep.id) });
    });
    const cancellations: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "DELETE") cancellations.push(request.url());
    });
    // The page's clock is frozen (the network isn't), so however slow this machine is, the second
    // click below always comes "straight after" the first as far as the page can tell.
    await page.clock.install();
    await page.goto("/orders");
    await page.clock.pauseAt(Date.now() + 60_000);

    // Click Cancel; once the list is rebuilt and the kept order's button has moved up into that spot,
    // click the same spot again, as a quick double-click would. It must not cancel the kept order.
    const cancel = page.getByRole("button", { name: `Cancel order for ${toCancel.name}`, exact: true });
    const keep = page.getByRole("button", { name: `Cancel order for ${toKeep.name}`, exact: true });
    const spot = await cancel.boundingBox();
    if (!spot) throw new Error("The Cancel button has no position on the page.");
    const middle = { x: spot.x + spot.width / 2, y: spot.y + spot.height / 2 };
    await page.mouse.click(middle.x, middle.y);
    await expect(cancel).toHaveCount(0);
    await expect.poll(async () => Math.abs(((await keep.boundingBox())?.y ?? -1000) - spot.y)).toBeLessThan(2);
    await page.mouse.click(middle.x, middle.y);
    // No second cancellation, then or after: wait until the page has no requests left in flight.
    await page.waitForLoadState("networkidle");

    expect(cancellations).toHaveLength(1);
    await expect(page.getByText(`Order for ${toCancel.name} cancelled.`, { exact: true })).toBeVisible();
    await expect(keep).toBeVisible();
    expect((await orders.list()).some((order) => order.id === toKeep.id)).toBe(true);

        // A slower second click at the same spot, with the pointer never moved, doesn't cancel it either.
    await page.clock.runFor(1000);
    await page.mouse.click(middle.x, middle.y);
    await page.waitForLoadState("networkidle");
    expect(cancellations).toHaveLength(1);
    expect((await orders.list()).some((order) => order.id === toKeep.id)).toBe(true);

    // Once the pointer has moved away and been aimed at the kept order, Cancel works again: the
    // guard doesn't leave the page dead.
    await page.mouse.move(middle.x, middle.y + 100);
    await keep.click();
    await expect(page.getByText(`Order for ${toKeep.name} cancelled.`, { exact: true })).toBeVisible();
    await expect.poll(async () => (await orders.list()).some((order) => order.id === toKeep.id)).toBe(false);
  },
);
