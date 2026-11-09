import { expect, test } from "@playwright/test";
import { EventsScreen, OrderReviewScreen } from "./pages/models.ts";

// Tests of the order review screen, written only against the page models in pages/models.ts:
// no selector appears here, so a change to either screen's markup is fixed in the models alone.
//
// Test data, all from the local demo pages (made-up data, nothing saved or sent):
//   event: Spring Concert, ticket price $25.00, service fee $2.50 per ticket
//   2 tickets -> $55.00; 4 tickets -> $110.00 (quantity x (price + fee))
//   a review link asking for 9 tickets -> "Choose from 1 to 6 tickets." and an empty summary
//   a review link naming an event that isn't on sale ("winter-gala", made up, and "constructor",
//   a name every JavaScript object has, which the review page once took for an event)
//   -> "That event isn't on sale. Go back to events to choose one." and an empty summary
//   3 tickets, then the browser's Back button -> the events page still shows 3 and $82.50
// Each test opens its own fresh page and changes nothing on the server, so each can run alone or
// in any order.
const EVENT = "Spring Concert";

test(
  "a buyer reviewing 2 Spring Concert tickets sees the event, 2 tickets and a total of $55.00",
  { tag: ["@order-review", "@risk-high", "@read-only", "@fast"] },
  async ({ page }) => {
    const events = new EventsScreen(page);
    await events.open();

    const review = await events.chooseTicketsAndReview(EVENT, 2);

    await expect(review.heading()).toBeVisible();
    await expect(review.eventName()).toHaveText(EVENT);
    await expect(review.ticketCount()).toHaveText("2");
    await expect(review.orderTotal()).toHaveText("$55.00");
    await expect(review.problem()).toBeHidden();
  },
);

test(
  "a buyer who goes back from the review to choose 4 tickets instead sees the new total of $110.00",
  { tag: ["@order-review", "@risk-high", "@read-only", "@fast"] },
  async ({ page }) => {
    const events = new EventsScreen(page);
    await events.open();
    const firstReview = await events.chooseTicketsAndReview(EVENT, 2);

    const eventsAgain = await firstReview.backToEvents();
    const secondReview = await eventsAgain.chooseTicketsAndReview(EVENT, 4);

    await expect(secondReview.ticketCount()).toHaveText("4");
    await expect(secondReview.orderTotal()).toHaveText("$110.00");
  },
);

test(
  "a review link asking for 9 tickets explains the 1 to 6 limit instead of showing a total",
  { tag: ["@order-review", "@risk-medium", "@read-only", "@fast"] },
  async ({ page }) => {
    const review = new OrderReviewScreen(page);
    await review.openFromLink("spring-concert", "9");

    await expect(review.problem()).toHaveText("Choose from 1 to 6 tickets.");
    await expect(review.eventName()).toHaveText("");
    await expect(review.ticketCount()).toHaveText("");
    await expect(review.orderTotal()).toHaveText("");
  },
);

test(
  "a review link naming an event that isn't on sale says so instead of showing a total",
  { tag: ["@order-review", "@risk-medium", "@read-only", "@fast"] },
  async ({ page }) => {
    const review = new OrderReviewScreen(page);

    for (const eventId of ["winter-gala", "constructor"]) {
      await review.openFromLink(eventId, "2");

      await expect(review.problem()).toHaveText("That event isn't on sale. Go back to events to choose one.");
      await expect(review.eventName()).toHaveText("");
      await expect(review.ticketCount()).toHaveText("");
      await expect(review.orderTotal()).toHaveText("");
    }
  },
);

test(
  "a buyer who uses the browser's Back button from the review still sees 3 tickets and $82.50",
  { tag: ["@order-review", "@risk-high", "@read-only", "@fast"] },
  async ({ page }) => {
    const events = new EventsScreen(page);
    await events.open();
    const review = await events.chooseTicketsAndReview(EVENT, 3);
    await expect(review.orderTotal()).toHaveText("$82.50");

    const eventsAgain = await review.goBackInBrowser();

    await expect(eventsAgain.ticketQuantity(EVENT)).toHaveValue("3");
    await expect(eventsAgain.orderTotal(EVENT)).toHaveText("Total: $82.50");
  },
);
