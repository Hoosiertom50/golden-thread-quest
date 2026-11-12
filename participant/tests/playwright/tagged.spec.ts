import { ask, baseUrl } from "./support/global-setup.ts";
import { expect, test } from "./support/orders-fixture.ts";
import { EventsScreen, OrderReviewScreen } from "./pages/models.ts";

// Eight tests for the tagging quest, chosen so that every tag in the scheme
// (participant/context/playwright/tag-scheme.md) is used at least once. Each test carries exactly one
// tag from each of the five dimensions: feature, risk, read/write, layer and duration.
// tools/tagging-check.ts checks the tags of every test in the project against the scheme, and the
// duration tags against the time each test really took.

const EVENT = "Spring Concert";

// @risk-low: only the site's name is checked. (A test of the prices shown is @risk-high: a wrong
// price shown to a buyer is money that is wrong.)
test(
  "the events page shows the Tixly name at the top",
  { tag: ["@events", "@risk-low", "@read-only", "@layer-ui", "@fast"] },
  async ({ page }) => {
    const events = new EventsScreen(page);
    await events.open();
    await expect(events.siteName()).toHaveText("Tixly");
  },
);

test(
  "choosing 3 tickets on the events page shows a total of $82.50",
  { tag: ["@events", "@risk-high", "@read-only", "@layer-ui", "@fast"] },
  async ({ page }) => {
    const events = new EventsScreen(page);
    await events.open();
    await events.chooseTickets(EVENT, 3);
    await expect(events.orderTotal(EVENT)).toHaveText("Total: $82.50");
  },
);

test(
  "the review page for 4 tickets shows a total of $110.00",
  { tag: ["@order-review", "@risk-high", "@read-only", "@layer-ui", "@fast"] },
  async ({ page }) => {
    const review = new OrderReviewScreen(page);
    await review.openFromLink("spring-concert", "4");
    await expect(review.ticketCount()).toHaveText("4");
    await expect(review.orderTotal()).toHaveText("$110.00");
  },
);

test(
  "a review link for an event not on sale says so instead of showing a total",
  { tag: ["@order-review", "@risk-medium", "@read-only", "@layer-ui", "@fast"] },
  async ({ page }) => {
    const review = new OrderReviewScreen(page);
    await review.openFromLink("winter-gala", "2");
    await expect(review.problem()).toHaveText("That event isn't on sale. Go back to events to choose one.");
    await expect(review.orderTotal()).toHaveText("");
  },
);

// @writes-data although nothing should be saved: if the app is broken, a 7-ticket order IS saved.
// So it carries a unique, run-marked name, and an order saved by mistake is cancelled straight away.
test(
  "the orders service refuses an order for 7 tickets",
  { tag: ["@saved-orders", "@risk-high", "@writes-data", "@layer-api", "@fast"] },
  async ({ orders }) => {
    const answer = await ask(new URL("/api/orders", baseUrl()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: orders.uniqueName(), event: "spring-concert", quantity: 7 }),
    });
    const body = (await answer.json()) as { id?: string; error?: string };
    if (answer.status === 201 && body.id) {
      await ask(new URL(`/api/orders/${encodeURIComponent(body.id)}`, baseUrl()), { method: "DELETE" });
    }
    expect(answer.status, "a 7-ticket order is refused").toBe(400);
    expect(body.error).toBe("Choose from 1 to 6 tickets.");
  },
);

test(
  "the orders service lists every order from before the run, each with an event and a number of tickets",
  { tag: ["@saved-orders", "@risk-medium", "@read-only", "@layer-api", "@fast"] },
  async ({ orders }) => {
    const preexisting = JSON.parse(process.env.TIXLY_PREEXISTING_IDS ?? "[]") as string[];
    const listed = await orders.list();
    for (const id of preexisting) {
      const order = listed.find((saved) => saved.id === id);
      expect(order, `order ${id} from before the run is listed`).toBeDefined();
      expect(order?.event).toBe("spring-concert");
      expect(order?.quantity).toBeGreaterThanOrEqual(1);
      expect(order?.quantity).toBeLessThanOrEqual(6);
    }
  },
);

test(
  "an order created through the API shows the right total on Your orders",
  { tag: ["@saved-orders", "@risk-high", "@writes-data", "@layer-mixed", "@fast"] },
  async ({ page, orders }) => {
    const order = await orders.create({ quantity: 2 });
    await page.goto("/orders");
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: order.name, exact: true }) });
    await expect(row.getByRole("cell")).toHaveText([order.name, EVENT, "2", "$55.00", "Cancel order"]);
  },
);

// @slow on purpose: every answer from the orders service reaches the page about 1.5 seconds late,
// as on a slow connection (only in this browser; the app itself is unchanged).
test(
  "cancelling still shows the right result on a slow connection",
  { tag: ["@saved-orders", "@risk-high", "@writes-data", "@layer-mixed", "@slow"] },
  async ({ page, orders }) => {
    const order = await orders.create({ quantity: 1 });
    await page.route("**/api/orders**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    });
    await page.goto("/orders");
    const cancel = page.getByRole("button", { name: `Cancel order for ${order.name}`, exact: true });
    await cancel.click();
    await expect(page.getByText(`Order for ${order.name} cancelled.`, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(cancel).toHaveCount(0);
    await expect.poll(async () => (await orders.list()).some((saved) => saved.id === order.id)).toBe(false);
  },
);
