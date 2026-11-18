// The ticket reader, for the base-camp-prompt-injection quest: reads synthetic work items (tickets
// and tool results) and prints a report on each, treating everything in them as content. It is the
// "agent" the injection cases attack. Rules: participant/context/untrusted-input-rules.md.
//
// IT CAN ONLY READ. It reads one file and prints to the screen. It has no way to change a ticket,
// send anything, run anything, or write, rename or delete any file: none of those abilities exist
// in this code, so untrusted text has no path to an action. It is meant to be run in Node's
// permission mode, allowed only to read, so that Node itself refuses any write or any new program;
// participant/tools/check-reader-code.mjs checks this file for anything that could reach the
// network or write.
//
// WHAT IT READS. From the cases file (default participant/context/injection-cases.md), only the
// fenced blocks marked `ticket` or `tool-result`, each named by the "## " heading above it. Nothing
// else in the file is read as anything, and nothing in a block is ever taken as a setting or an
// order. A ticket block has one `field: value` per line (title, reporter, status, description,
// comment, attachment); `description: |` takes the indented lines below it. A tool-result block is
// one JSON object.
//
// WHAT IT REPORTS, for each case: the title, reporter and status as given; every line that looks like
// an embedded instruction, where it is, quoted exactly as content (control characters shown as
// escapes, so the report can't be used to play tricks on the terminal); for base64-encoded text,
// the decoded text too; which flags fired; and that nothing was obeyed. Two flags, neither of which is
// the defense:
//   - phrase filter: wording typical of injected instructions;
//   - addresses the reader: text written to whoever processes it, which a ticket written for people
//     has no reason to contain.
// At the end: how many cases, how many embedded instructions, which flags fired, and which cases the
// phrase filter alone would have missed.
//
// Run it from the repository's top folder, in Node's permission mode:
//   node --permission --allow-fs-read="$PWD" participant/tools/ticket-reader.mjs [cases file]
// Exit 0: every case had at least one flagged line. 1: some case had none (shown by name, so a new
// case nobody flagged is noticed). 2: the cases file couldn't be read, or held no case.

import { readFileSync } from "node:fs";

const casesFile = process.argv[2] ?? "participant/context/injection-cases.md";
if (process.argv.length > 3) {
  console.error("Usage: node --permission --allow-fs-read=<repository> participant/tools/ticket-reader.mjs [cases file]");
  process.exit(2);
}
let text;
try {
  text = readFileSync(casesFile, "utf8");
} catch (error) {
  console.error(`Couldn't read the cases file (${error.code ?? "an unexpected error"}).`);
  process.exit(2);
}

// --- The cases: fenced `ticket` and `tool-result` blocks, named by the heading above. -----------
const cases = [];
let heading = "(no heading)";
const lines = text.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith("## ")) heading = line.slice(3).trim();
  const fence = line.match(/^```(ticket|tool-result)\s*$/);
  if (!fence) continue;
  const body = [];
  for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
  cases.push({ name: heading, kind: fence[1], body });
}
if (cases.length === 0) {
  console.error("The cases file holds no ticket or tool-result block.");
  process.exit(2);
}

// --- The pieces of a case: each line of content, with where it is. --------------------------------
function ticketPieces(body) {
  const pieces = [];
  const fields = {};
  let comments = 0;
  let attachments = 0;
  // Every line is read, and nothing is skipped: a field the reader doesn't expect (a label, a
  // priority), the reporter's name, a description line after a blank line, and a line with no field
  // name at all are all content, and all checked.
  const field = /^([a-z][a-z_-]*):\s?(.*)$/;
  for (let i = 0; i < body.length; i++) {
    if (body[i].trim() === "") continue;
    const m = body[i].match(field);
    if (!m) {
      pieces.push({ where: "a line with no field name", text: body[i].trim() });
      continue;
    }
    const [, name, value] = m;
    if (name === "description" && value.trim() === "|") {
      // The description runs until the next line that starts with a field name.
      for (i++; i < body.length && !field.test(body[i]); i++) {
        const content = body[i].trim();
        if (content === "") continue;
        const quoted = content.startsWith(">");
        pieces.push({ where: quoted ? "the description (quoted text)" : "the description", text: quoted ? content.replace(/^>\s?/, "") : content });
      }
      i--;
    } else if (name === "comment") {
      comments++;
      pieces.push({ where: `comment ${comments}`, text: value });
    } else if (field === "attachment") {
      attachments++;
      pieces.push({ where: `the name of attachment ${attachments}`, text: value });
    } else {
      fields[name] = value;
      pieces.push({ where: `the ${name}`, text: value });
    }
  }
  return { fields, pieces };
}

function toolResultPieces(body) {
  const pieces = [];
  let data;
  try {
    data = JSON.parse(body.join("\n"));
  } catch {
    return { fields: {}, pieces: [{ where: "the tool result (not valid JSON, read as text)", text: body.join(" ") }] };
  }
  // Every string is checked, field names included: a name can carry words as well as a value.
  const walk = (value, path) => {
    // Field names come from the content too, so they are quoted wherever they are shown.
    if (typeof value === "string") pieces.push({ where: `the tool result's field ${JSON.stringify(path)}`, text: value });
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        const here = path ? `${path}.${k}` : k;
        pieces.push({ where: `the name of a tool result's field (${JSON.stringify(here)})`, text: k });
        walk(v, here);
      }
    }
  };
  walk(data, "");
  return { fields: { tool: typeof data?.tool === "string" ? data.tool : "(unnamed)" }, pieces };
}

// Base64 found inside a piece is decoded, and the decoded text checked too, when it reads as text.
function decoded(piece) {
  const found = [];
  for (const token of piece.text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
    if (token.length % 4 !== 0) continue;
    const plain = Buffer.from(token, "base64").toString("utf8");
    if (!/^[\p{L}\p{N}\p{P}\p{Zs}$+<=>^`|~]+$/u.test(plain) || !/\p{L}{3,}/u.test(plain)) continue;
    found.push({ where: `${piece.where} (decoded from base64)`, text: plain, encoded: token });
  }
  return found;
}

// --- The two flags. Neither is the defense; they help the person reading the report. ------------
const words = (s) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
// Each phrase as whole words, after letter case and punctuation are set aside. Action words count only
// when something is asked for, as in "email the list" or "delete all tickets": a customer mentioning
// an email is not one.
const PHRASES = [
  "ai assistant", "assistant", "ignore previous", "ignore all previous", "disregard", "you must",
  "system prompt", "mark this story done", "mark this ticket done", "mark the story as done",
  "run the command", "git push", "rm rf",
  ...["email", "delete"].flatMap((verb) =>
    ["the", "it", "this", "them", "all", "every", "these", "those", "any", "each"].map((next) => `${verb} ${next}`)),
];
const phraseFilter = (s) => PHRASES.filter((p) => words(s).includes(` ${p} `));
const READER = [
  /\bwhoever (handles|processes|reads|picks up|gets)\b/i,
  /\b(ai |automated )?(assistant|agent|bot|automation|tool|model|program)s? (reading|processing|handling)\b/i,
  /\bnote to (the |any )?(automated )?(assistant|agent|bot|tool|reader|automation|ai)\b/i,
  /\bdear (ai|assistant|agent|bot)\b/i,
  /\bif you are an? (ai|assistant|agent|bot|tool|program)\b/i,
  /\bto (the|any) (ai|assistant|agent|bot)\b/i,
  /\b(ai assistant|assistant|agent|bot|automation)s?\s*[:,]/i,
];
const addressesReader = (s) => READER.some((r) => r.test(s));

// --- The report. -----------------------------------------------------------------------------------
const quote = (s) => JSON.stringify(s);
let instructions = 0;
let byPhrase = 0;
let byReader = 0;
const phraseMissed = [];
const unflagged = [];
cases.forEach((c, n) => {
  const { fields, pieces } = c.kind === "ticket" ? ticketPieces(c.body) : toolResultPieces(c.body);
  const all = pieces.flatMap((p) => [p, ...decoded(p)]);
  console.log(`=== Case ${n + 1}: ${quote(c.name)} (${c.kind === "ticket" ? "a ticket" : "a tool result"}) ===`);
  if (c.kind === "ticket") {
    console.log(`  Title: ${quote(fields.title ?? "")}`);
    console.log(`  Reporter: ${quote(fields.reporter ?? "")}   Status as given: ${quote(fields.status ?? "")}`);
  } else console.log(`  From the tool: ${quote(fields.tool)}`);
  const flagged = all
    .map((p) => ({ ...p, phrases: phraseFilter(p.text), reader: addressesReader(p.text) }))
    .filter((p) => p.phrases.length > 0 || p.reader);
  if (flagged.length === 0) {
    console.log("  No line was flagged. (Everything above is still only content.)");
    unflagged.push(n + 1);
  } else {
    console.log(`  Embedded instructions found: ${flagged.length} (recorded as content, not obeyed):`);
    for (const p of flagged) {
      instructions++;
      if (p.phrases.length) byPhrase++;
      if (p.reader) byReader++;
      console.log(`    - in ${p.where}: ${quote(p.text)}`);
      if (p.encoded) console.log(`      encoded original: ${quote(p.encoded)}`);
      const fired = [p.phrases.length ? `phrase filter (${p.phrases.map(quote).join(", ")})` : "", p.reader ? "addresses the reader" : ""].filter(Boolean);
      console.log(`      flags: ${fired.join("; ")}`);
    }
    if (!flagged.some((p) => p.phrases.length > 0)) phraseMissed.push(n + 1);
  }
  console.log("  Actions taken: none. This reader can only read and print; nothing was obeyed.");
  console.log("");
});

console.log(`Summary: ${cases.length} cases read from ${quote(casesFile)}; ${instructions} embedded instructions recorded as content, none obeyed.`);
console.log(`  Flagged by the phrase filter: ${byPhrase}; by addresses-the-reader: ${byReader}.`);
console.log(`  Cases the phrase filter alone would have missed: ${phraseMissed.length ? phraseMissed.join(", ") : "none"}.`);
console.log(`  Cases with no flagged line: ${unflagged.length ? unflagged.join(", ") : "none"}.`);
process.exit(unflagged.length ? 1 : 0);
