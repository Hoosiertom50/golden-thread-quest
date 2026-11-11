import { expect, test } from "./support/orders-fixture.ts";

// The ISOLATED version of coupled.spec.ts, for the data-isolation quest: the same two stories, but
// each test creates the order it needs, with a name no other test, run or tester can share, and
// the orders helper cancels exactly what the test created when it ends, whether it passed or
// failed. Neither test relies on the other, so they pass in any order and in parallel.
//
// Names look like "Test User qa-0d4f2a-7k2m": "qa-0d4f2a" marks this run, "7k2m" this order.

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
    await page.goto("/orders");

    await page.getByRole("button", { name: `Cancel order for ${toCancel.name}`, exact: true }).click();

    await expect(page.getByText(`Order for ${toCancel.name} cancelled.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Cancel order for ${toCancel.name}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Cancel order for ${toKeep.name}`, exact: true })).toBeVisible();
  },
);
