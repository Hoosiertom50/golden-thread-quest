// Runs once, after every test has finished: the safety net. Each test already cancels the orders it
// noted (orders-fixture.ts), so normally this finds nothing. If a test was cut short before it
// could note an order (a crash, a timeout at the wrong moment), its order still carries this run's
// marker in its name, and is cancelled here. Only orders with THIS run's marker are touched: never
// an order without it, and never another run's.

import { runMarker, type SavedOrder } from "./orders-fixture.ts";

export default async function globalTeardown(): Promise<void> {
  const marker = runMarker();
  const base = process.env.TIXLY_BASE_URL ?? `http://127.0.0.1:${process.env.TIXLY_DEMO_PORT ?? "4173"}`;
  const all = (await (await fetch(`${base}/api/orders`)).json()) as SavedOrder[];
  const leftovers = all.filter((order) => order.name.includes(` ${marker}-`));
  for (const order of leftovers) {
    await fetch(`${base}/api/orders/${encodeURIComponent(order.id)}`, { method: "DELETE" });
  }
  if (leftovers.length > 0) {
    console.log(`Safety net: cancelled ${leftovers.length} order(s) left with run marker ${marker}.`);
  }
}
