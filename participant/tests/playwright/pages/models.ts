import type { Locator, Page } from "@playwright/test";

// Page models for the two Tixly demo screens: the events page and the order review page.
//
// Every way of finding something on a screen lives here, by role, label or visible text (what a
// user or a screen reader would describe), so a change to a screen is fixed in this one file and
// no test has to change. Methods are named for what a user does or reads (chooseTickets,
// reviewOrder, orderTotal), not for the element they touch. There are no assertions here: the
// models find and do, and the tests decide whether the result is right.

// The events page (/): one card per event, with a ticket quantity, a running total and a
// "Review order" button.
export class EventsScreen {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.goto("/");
  }

  // One event's card, found by the event's name.
  event(name: string): Locator {
    return this.page.getByRole("article", { name });
  }

  async chooseTickets(eventName: string, quantity: number): Promise<void> {
    await this.event(eventName).getByLabel("Number of tickets").selectOption(String(quantity));
  }

  // Go on to the review screen for the tickets chosen on an event's card.
  async reviewOrder(eventName: string): Promise<void> {
    await this.event(eventName).getByRole("button", { name: "Review order" }).click();
  }

  // Choose tickets and go straight to the review screen, the most common path through this page.
  async chooseTicketsAndReview(eventName: string, quantity: number): Promise<OrderReviewScreen> {
    await this.chooseTickets(eventName, quantity);
    await this.reviewOrder(eventName);
    return new OrderReviewScreen(this.page);
  }
}

// The order review page (/review): what the buyer is about to order, before paying.
export class OrderReviewScreen {
  constructor(private readonly page: Page) {}

  // Open the review screen straight from an address, as a buyer would by following a saved or
  // shared link. The event is given by its id in the address (for example "spring-concert") and
  // the quantity as typed, so a test can try a quantity the events page would never offer.
  async openFromLink(eventId: string, quantity: string): Promise<void> {
    const query = new URLSearchParams({ event: eventId, quantity });
    await this.page.goto(`/review?${query}`);
  }

  heading(): Locator {
    return this.page.getByRole("heading", { name: "Review your order" });
  }

  // One line of the order summary, found by its row heading ("Event", "Tickets" or "Total").
  private summaryValue(rowHeading: string): Locator {
    return this.page
      .getByRole("table", { name: "Order summary" })
      .getByRole("row", { name: new RegExp(`^${rowHeading}\\b`) })
      .getByRole("cell");
  }

  eventName(): Locator {
    return this.summaryValue("Event");
  }

  ticketCount(): Locator {
    return this.summaryValue("Tickets");
  }

  orderTotal(): Locator {
    return this.summaryValue("Total");
  }

  // The message shown instead of a total when the order can't be reviewed.
  problem(): Locator {
    return this.page.getByRole("alert");
  }

  async backToEvents(): Promise<EventsScreen> {
    await this.page.getByRole("link", { name: "Back to events" }).click();
    return new EventsScreen(this.page);
  }
}
