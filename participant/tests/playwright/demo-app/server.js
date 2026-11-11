// A tiny local web server for the Tixly demo pages, on this computer only (127.0.0.1), so the tests
// never reach a real site. Playwright starts and stops it for each run; the port comes from
// TIXLY_DEMO_PORT (default 4173).
//
// Pages (GET only): the events page (/), the order review page (/review, which reads the event and
// quantity from its address) and the saved orders page (/orders).
//
// Orders service, for saved orders kept in data/orders.json (a stand-in for a real database: what
// is saved stays saved between runs, until it is cancelled):
//   GET    /api/orders       every saved order
//   POST   /api/orders       save one: {"name": ..., "event": ..., "quantity": ...}; answers with the
//                            saved order, including its new id
//   DELETE /api/orders/<id>  cancel the order with that id
// Each request reads and writes the whole file without pausing in between, and the server handles
// one request at a time, so two tests saving at once can't overwrite each other's orders.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const portSetting = process.env.TIXLY_DEMO_PORT ?? "4173";
if (!/^[1-9][0-9]{0,4}$/.test(portSetting) || Number(portSetting) > 65535) {
  console.error(`TIXLY_DEMO_PORT must be a whole number from 1 to 65535, not "${portSetting}"`);
  process.exit(1);
}
const port = Number(portSetting);
const eventsPage = readFileSync(new URL("./index.html", import.meta.url));
const reviewPage = readFileSync(new URL("./review.html", import.meta.url));
const ordersPage = readFileSync(new URL("./orders.html", import.meta.url));
const ordersFile = new URL("./data/orders.json", import.meta.url);
const ordersTemporary = new URL("./data/orders.json.tmp", import.meta.url);

// The events that can be ordered, and the longest buyer name.
const EVENTS = new Set(["spring-concert"]);
const MAX_NAME = 60;

// Which page a path asks for, or null. Only the path counts: a query string
// (?event=...&quantity=... on the review page, or anything a link adds) is left for the page.
function pageFor(path) {
  if (path === "/" || path === "/index.html") return eventsPage;
  if (path === "/review") return reviewPage;
  if (path === "/orders") return ordersPage;
  return null;
}

function readOrders() {
  return JSON.parse(readFileSync(ordersFile, "utf8"));
}

// Written to a temporary file first and then moved into place, so the file is never left
// half-written. Two-space indentation and a final new line, the same as the file in Git, so once
// the tests have cleaned up, the file is byte for byte what it was.
function writeOrders(orders) {
  writeFileSync(ordersTemporary, `${JSON.stringify(orders, null, 2)}\n`);
  renameSync(ordersTemporary, ordersFile);
}

// A saved order must name a buyer (1 to 60 characters, not only spaces), an event on sale and a
// whole number of tickets from 1 to 6. Returns the order to save, or a message saying what's wrong.
function validOrder(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Send the order as a JSON object.";
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > MAX_NAME) return `Give a name of 1 to ${MAX_NAME} characters.`;
  if (typeof body.event !== "string" || !EVENTS.has(body.event)) return "That event isn't on sale.";
  if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 6) {
    return "Choose from 1 to 6 tickets.";
  }
  return { name, event: body.event, quantity: body.quantity };
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function handleOrders(request, response, path, bodyText) {
  if (path === "/api/orders" && request.method === "GET") return send(response, 200, readOrders());
  if (path === "/api/orders" && request.method === "POST") {
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return send(response, 400, { error: "Send the order as a JSON object." });
    }
    const order = validOrder(body);
    if (typeof order === "string") return send(response, 400, { error: order });
    const saved = { id: `o-${randomBytes(4).toString("hex")}`, ...order };
    writeOrders([...readOrders(), saved]);
    return send(response, 201, saved);
  }
  const match = /^\/api\/orders\/(o-[a-z0-9-]{1,40})$/.exec(path);
  if (match && request.method === "DELETE") {
    const orders = readOrders();
    const remaining = orders.filter((order) => order.id !== match[1]);
    if (remaining.length === orders.length) return send(response, 404, { error: "No order with that id." });
    writeOrders(remaining);
    return send(response, 200, { cancelled: match[1] });
  }
  return send(response, 404, { error: "Not found" });
}

createServer((request, response) => {
  const path = (request.url ?? "").split("?")[0];
  if (path === "/api/orders" || path.startsWith("/api/orders/")) {
    // Orders are small; a request body over 10 KB is refused rather than read.
    let bodyText = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      bodyText += chunk;
      if (bodyText.length > 10_000 && !response.writableEnded) {
        send(response, 413, { error: "Too large." });
        request.destroy();
      }
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      // If the orders file can't be read (damaged, or not valid JSON), say so instead of crashing:
      // the pages keep working, and the file is left as it is (every change is made only after a
      // successful read), so it can still be put right by hand.
      try {
        handleOrders(request, response, path, bodyText);
      } catch (problem) {
        console.error(`Orders service: ${problem instanceof Error ? problem.message : problem}`);
        if (!response.headersSent) send(response, 500, { error: "The saved orders file can't be read." });
      }
    });
    return;
  }
  const page = pageFor(path);
  if (request.method !== "GET" || page === null) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
}).listen(port, "127.0.0.1", () => {
  console.log(`Tixly demo app on http://127.0.0.1:${port}`);
});
