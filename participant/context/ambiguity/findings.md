# Findings: Tixly checkout requirements

Review of `participant/context/ambiguity/requirements.md` (12 requirements, CHK-01 to CHK-12).
Reviewed 10-26-2026 by Tom Carter, as a blind review: the requirements were drafted for the
exercise with an answer key sealed before the review, and compared only afterwards.

## The four defect types

Each finding names exactly one type. A requirement with two problems has two findings.

| Type | Meaning | Quick test |
|---|---|---|
| Vague | It names something measurable but gives no measure. | Adding a number or limit would fix it; two testers would pick different numbers. |
| Incomplete | It leaves out a case or behaviour a tester needs. | The happy path is testable, but a "what if…?" has no expected result. |
| Contradictory | Two requirements can't both be true. | Passing one means failing the other. Always cites both. |
| Untestable | No test could ever pass or fail it. | No expected result can be written, and no number would fix that. |

Tie-breaker when the same words seem to fit two types: if a number would fix it, vague; if no
number could, untestable; if a whole situation is missing, incomplete.

Findings ask the question that would resolve them. They never rewrite the requirement; deciding
the answer is the author's call.

## Findings

### F-01
- **Requirement:** CHK-02
- **Type:** Vague
- **Words in CHK-02:** "quickly"
- **A tester couldn't decide:** how many seconds counts as a pass, so two testers would pass and fail different load times.
- **Question:** How many seconds may the seat map take to load?

### F-02
- **Requirement:** CHK-02
- **Type:** Incomplete
- **Words in CHK-02:** "must load"
- **A tester couldn't decide:** the conditions to test under, or where the timing starts and stops.
- **Question:** Under what conditions is the load time measured (connection, device, size of the venue), and from what moment to what moment?

### F-03
- **Requirement:** CHK-04
- **Type:** Incomplete
- **Words in CHK-04:** "The gift card balance is deducted from the order total."
- **A tester couldn't decide:** whether using part of a card is allowed, or what the card should show after an order smaller than its balance.
- **Question:** Can the buyer use only part of the gift card balance, and if so, how?
- **Question:** When the gift card is worth more than the order, what happens to the remaining balance?

### F-04
- **Requirement:** CHK-05
- **Type:** Incomplete
- **Words in CHK-05:** "Refunds are available up to 48 hours before the event starts."
- **A tester couldn't decide:** how a refund should arrive, what a request inside 48 hours should produce, or when a refund may be refused.
- **Question:** How is the refund given: back to the original payment, as Tixly credit, or another way?
- **Question:** What happens to a refund request made less than 48 hours before the event: a partial refund, or none?
- **Question:** Does the buyer have to give a reason for the refund?
- **Question:** Are there reasons a refund would be denied?

### F-05
- **Requirement:** CHK-06
- **Type:** Incomplete
- **Words in CHK-06:** "Tixly sends a confirmation email"
- **A tester couldn't decide:** the expected result for an order with no email address.
- **Question:** What happens when the buyer has no email address on the order?

### F-06
- **Requirement:** CHK-07
- **Type:** Untestable
- **Words in CHK-07:** "feel trustworthy"
- **A tester couldn't decide:** anything to check: a feeling has no expected result, and no number could decide it.
- **Question:** What would a tester check to decide whether checkout is trustworthy for a first-time buyer?

### F-07
- **Requirement:** CHK-05, CHK-08
- **Type:** Contradictory
- **Words in CHK-05:** "up to 48 hours before the event starts"
- **Words in CHK-08:** "at any time until the venue doors open"
- **A tester couldn't decide:** the expected result for a cancellation 24 hours before the event: CHK-08 gives a full refund, CHK-05 gives none.
- **Question:** Which refund deadline applies: 48 hours before the event starts, or until the venue doors open?

### F-08
- **Requirement:** CHK-09
- **Type:** Incomplete
- **Words in CHK-09:** "A service fee of $2.50 per ticket"
- **A tester couldn't decide:** whether a payment page that adds tax on the fee is right or wrong.
- **Question:** Is the service fee taxed, and if so, is the tax shown with it?

### F-09
- **Requirement:** CHK-10
- **Type:** Incomplete
- **Words in CHK-10:** "If a payment is declined, the buyer sees an error message."
- **A tester couldn't decide:** whether the message shown is the right one, or what the buyer should be able to do next.
- **Question:** What does the message say when a payment is declined?
- **Question:** After the message, what can the buyer do next: try the payment again, or cancel back to the cart?

### F-10
- **Requirement:** CHK-12
- **Type:** Untestable
- **Words in CHK-12:** "any number of buyers"
- **A tester couldn't decide:** when the test is finished: however many buyers are tested, "any number" includes more.
- **Question:** What is the largest number of buyers checking out at the same time that the system must support?

### F-11
- **Requirement:** CHK-12
- **Type:** Vague
- **Words in CHK-12:** "handle"
- **A tester couldn't decide:** what to measure, so two testers would check different things.
- **Question:** What counts as handling them: no errors, a response time, no seat sold twice?

## Unflagged requirements

- **CHK-01:** States the limit (8 seats), the exact message for a 9th seat, and that the 9th seat isn't held, so a tester knows what to try and what to expect.
- **CHK-03:** States the trigger (payment not completed), the timing (10 minutes after the hold starts) and the visible result (the seats show as available on the seat map).
- **CHK-11:** States a precise rule (the total shown equals the amount charged, to the cent) that a tester can check directly. Removed on a second look: I first asked what happens when the two don't match, but a mismatch is simply the test failing and a bug being logged; asking Tixly to detect it and stop the charge would be a new feature, not a gap in this requirement.
