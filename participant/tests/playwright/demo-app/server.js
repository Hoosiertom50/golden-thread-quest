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
// Each request reads, changes and writes the whole file in one uninterrupted step (no waiting in
// between, so no other request can run in the middle), so two tests saving at once through this
// server can't overwrite each other's orders.

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
// Named after this server process, so two servers sharing the file never write the same
// temporary file (they can still lose each other's changes: run one server per orders file).
const ordersTemporary = new URL(`./data/orders.json.${process.pid}.tmp`, import.meta.url);

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

// What an order id looks like: the same rule the cancel route uses, so every listed order can be
// cancelled.
const ORDER_ID = /^o-[a-z0-9-]{1,40}$/;

// A problem reading the saved orders (as opposed to saving them).
class Unreadable extends Error {}

// The saved orders. Anything that isn't a list of complete orders (an id, a name, an event and a
// whole number of tickets) counts as unreadable (the caller answers "can't be read"), so it is never
// listed, and never written over.
function readOrders() {
  let orders;
  try {
    orders = JSON.parse(readFileSync(ordersFile, "utf8"));
  } catch (problem) {
    throw new Unreadable(problem instanceof Error ? problem.message : String(problem));
  }
  const complete = (order) =>
    typeof order?.id === "string" &&
    ORDER_ID.test(order.id) &&
    typeof order.name === "string" &&
    order.name !== "" &&
    typeof order.event === "string" &&
    Number.isInteger(order.quantity);
  if (!Array.isArray(orders) || !orders.every(complete)) {
    throw new Unreadable("the orders file isn't a list of complete orders");
  }
  // Each id once: cancelling by id must only ever reach one order.
  if (new Set(orders.map((order) => order.id)).size !== orders.length) {
    throw new Unreadable("the orders file has the same order id more than once");
  }
  return orders;
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
  // A name has to show something: no control characters, and at least one letter, digit or mark
  // once the characters that draw nothing are set aside (spaces, zero-width and format characters,
  // and blank-looking ones such as the braille blank or the Hangul fillers).
  const visible = name.replace(/[\p{Z}\p{Cf}\u2800\u115F\u1160\u3164\uFFA0]/gu, "");
  const shows = /[\p{L}\p{N}\p{P}\p{S}]/u.test(visible) && !/\p{Cc}/u.test(name);
  if (!shows || name.length > MAX_NAME) return `Give a name of 1 to ${MAX_NAME} characters.`;
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

// A save or cancel sent by another website (a page open in the browser can send one to this
// computer) is refused: a browser always says which site a request comes from (Origin), and it must
// be this app itself. The tests' own requests come from no website, so they carry no Origin.
function fromAnotherSite(request) {
  const origin = request.headers.origin;
  return origin !== undefined && origin !== `http://${request.headers.host}`;
}

function handleOrders(request, response, path, bodyText) {
  if (path === "/api/orders" && request.method === "GET") return send(response, 200, readOrders());
  if ((request.method === "POST" || request.method === "DELETE") && fromAnotherSite(request)) {
    return send(response, 403, { error: "Orders can only be changed from this app." });
  }
  if (path === "/api/orders" && request.method === "POST") {
    // Only a JSON save: a plain-text one is what another site can send without asking first.
    // The media type, without parameters such as "; charset=utf-8", in any letter case.
    const mediaType = (request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      return send(response, 415, { error: "Send the order as JSON." });
    }
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return send(response, 400, { error: "Send the order as a JSON object." });
    }
    const order = validOrder(body);
    if (typeof order === "string") return send(response, 400, { error: order });
    const orders = readOrders();
    // A new random id, never one already in use: cancelling by id must only ever reach one order.
    let id;
    do id = `o-${randomBytes(4).toString("hex")}`;
    while (orders.some((existing) => existing.id === id));
    const saved = { id, ...order };
    writeOrders([...orders, saved]);
    return send(response, 201, saved);
  }
  const match = /^\/api\/orders\/(.+)$/.exec(path);
  if (match && !ORDER_ID.test(match[1])) return send(response, 404, { error: "No order with that id." });
  if (match && request.method === "DELETE") {
    const orders = readOrders();
    const remaining = orders.filter((order) => order.id !== match[1]);
    if (remaining.length === orders.length) return send(response, 404, { error: "No order with that id." });
    writeOrders(remaining);
    return send(response, 200, { cancelled: match[1] });
  }
  return send(response, 404, { error: "Not found" });
}

// Only requests addressed to this computer, by its own address, are answered. A website can make a
// browser send requests to this app under the website's own name (DNS rebinding); refusing every
// other name stops that, and makes the Origin check below compare against a name we trust.
// (On port 80, browsers leave the port out of the name, so the bare names count too.)
const OWN_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(port === 80 ? ["127.0.0.1", "localhost"] : [])]);

createServer((request, response) => {
  if (!OWN_HOSTS.has(request.headers.host ?? "")) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("This app only answers requests addressed to 127.0.0.1 or localhost.");
    return;
  }
  const path = (request.url ?? "").split("?")[0];
  if (path === "/api/orders" || path.startsWith("/api/orders/")) {
    // Orders are small; a request body over 10 KB (counted in bytes, as sent) is refused rather
    // than read.
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 10_000 && !response.writableEnded) {
        send(response, 413, { error: "Too large." });
        request.destroy();
      }
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      const bodyText = Buffer.concat(chunks).toString("utf8");
      // If the orders file can't be read (damaged, or not valid JSON) or can't be updated (a full
      // disk, no permission), say which instead of crashing: the pages keep working, and the file
      // is left as it is (every change is made only after a successful read and written whole), so
      // it can still be put right by hand.
      try {
        handleOrders(request, response, path, bodyText);
      } catch (problem) {
        console.error(`Orders service: ${problem instanceof Error ? problem.message : problem}`);
        const error = problem instanceof Unreadable ? "The saved orders file can't be read." : "The saved orders file couldn't be updated.";
        if (!response.headersSent) send(response, 500, { error });
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
  // Never shown inside another site's frame, so no site can trick a click on Save or Cancel
  // (clickjacking).
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
  });
  response.end(page);
}).listen(port, "127.0.0.1", () => {
  console.log(`Tixly demo app on http://127.0.0.1:${port}`);
});
