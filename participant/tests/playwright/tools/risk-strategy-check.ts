// risk-strategy-check: checks the Tixly layered test strategy against its requirements.
//
// Reads participant/context/playwright/requirements.md and strategy.md and checks that:
//   - the likelihood and impact scales are stated, each at 3, 2 and 1;
//   - every risk has exactly one layer (unit, API, UI, manual or untested) and a reason;
//   - every requirement appears in the strategy;
//   - risks that need a browser are kept apart from those that don't;
//   - every untested risk is listed with its reason and who accepted it;
//   - the ranking table is exactly what the stated scales and tie rules produce.
//
// It reads only those two files and writes nothing. Both files are read strictly: a line it
// doesn't recognise in a requirement or risk entry is reported, not skipped, so a typo can't
// quietly drop an entry from the check.
//
// Run from the repository root (Node 22.18 or later runs TypeScript directly, nothing to install):
//   node participant/tests/playwright/tools/risk-strategy-check.ts
// Optional: --requirements <path> --strategy <path>
// Exit status: 0 passed, 1 failed, 2 a file couldn't be read or the arguments were wrong.

import { readFileSync } from "node:fs";

const VERSION = "1.0.0";
const DEFAULT_REQUIREMENTS = "participant/context/playwright/requirements.md";
const DEFAULT_STRATEGY = "participant/context/playwright/strategy.md";

const LAYERS = ["unit", "API", "UI", "manual", "untested"] as const;
type Layer = (typeof LAYERS)[number];
const IMPORTANCE = new Map<string, number>([["High", 3], ["Medium", 2], ["Low", 1]]);
const MIN_REASON_WORDS = 8;

const BROWSER_SECTION = "Risks that need a browser";
const NO_BROWSER_SECTION = "Risks that don't need a browser";
const UNTESTED_SECTION = "Accepted as untested";
const RISK_SECTIONS = [BROWSER_SECTION, NO_BROWSER_SECTION, UNTESTED_SECTION];
// Which layers each risk section may hold. A manual check may or may not need a browser.
const SECTION_LAYERS: Record<string, Layer[]> = {
  [BROWSER_SECTION]: ["UI", "manual"],
  [NO_BROWSER_SECTION]: ["unit", "API", "manual"],
  [UNTESTED_SECTION]: ["untested"],
};

interface Requirement {
  id: string;
  importance: string;
}

interface Risk {
  id: string;
  section: string;
  requirements: string[];
  likelihood: number;
  impact: number;
  layer: Layer;
  reason: string;
  acceptedBy: string;
}

class Unreadable extends Error {}

const problems: string[] = [];

function problem(message: string): void {
  problems.push(message);
}

// Characters a reader can't see, or that look like an ordinary space but aren't one. A line with
// any of them is refused, so an entry can't hide text or look different from what is checked.
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]|(?! )\p{Zs}/u;

function readLines(path: string, what: string): string[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const reason = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
    throw new Unreadable(`can't read the ${what} file ${path} (${reason})`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    problem(`${path}: the file is not valid UTF-8 text`);
    text = new TextDecoder("utf-8").decode(bytes);
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  lines.forEach((line, index) => {
    if (INVISIBLE.test(line)) {
      problem(`${path} line ${index + 1}: contains an invisible or unusual character`);
    }
  });
  return lines;
}

// A field line looks exactly like "- **Name:** value".
function field(line: string | undefined, name: string): string | null {
  const prefix = `- **${name}:** `;
  if (line === undefined || !line.startsWith(prefix)) return null;
  const value = line.slice(prefix.length).trim();
  return value === "" ? null : value;
}

// Splits a file into its "## " sections, keeping each section's lines and where they start.
// An entry heading ("### ") is allowed only in the sections named in entrySections, so an entry
// placed anywhere else is reported rather than silently left out of the check.
function sections(
  path: string,
  lines: string[],
  entrySections: string[],
): Map<string, { start: number; lines: string[] }> {
  const found = new Map<string, { start: number; lines: string[] }>();
  let name = "";
  let current: { start: number; lines: string[] } | null = null;
  lines.forEach((line, index) => {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      name = (heading[1] ?? "").trim();
      current = { start: index + 2, lines: [] };
      if (found.has(name)) problem(`${path}: the section "${name}" appears more than once`);
      found.set(name, current);
      return;
    }
    if (line.startsWith("### ") && !entrySections.includes(name)) {
      problem(`${path} line ${index + 1}: "${line}" is outside the sections that hold entries`);
    }
    if (current) current.lines.push(line);
  });
  return found;
}

// Splits a section into "### ID" entries. Any other non-blank line outside an entry is reported,
// unless the section allows free text before its first entry.
function entries(
  path: string,
  section: { start: number; lines: string[] },
  idPattern: RegExp,
  introAllowed: boolean,
): { id: string; line: number; fields: string[] }[] {
  const result: { id: string; line: number; fields: string[] }[] = [];
  section.lines.forEach((line, offset) => {
    const lineNumber = section.start + offset;
    if (line.startsWith("### ")) {
      const id = line.slice(4);
      if (!idPattern.test(id)) {
        problem(`${path} line ${lineNumber}: "${line}" is not an entry heading in the expected form`);
      }
      result.push({ id, line: lineNumber, fields: [] });
    } else if (result.length > 0) {
      const last = result[result.length - 1];
      if (last && line.trim() !== "") last.fields.push(line);
    } else if (!introAllowed && line.trim() !== "") {
      problem(`${path} line ${lineNumber}: unexpected text before the first entry`);
    }
  });
  return result;
}

function readRequirements(path: string): Requirement[] {
  const lines = readLines(path, "requirements");
  const section = sections(path, lines, ["Requirements"]).get("Requirements");
  if (!section) {
    problem(`${path}: no "## Requirements" section`);
    return [];
  }
  const requirements: Requirement[] = [];
  const seen = new Set<string>();
  for (const entry of entries(path, section, /^CHK-\d{2}$/, false)) {
    const where = `${path} ${entry.id} (line ${entry.line})`;
    if (seen.has(entry.id)) problem(`${where}: the id is used more than once`);
    seen.add(entry.id);
    const names = ["Importance", "Requirement", "Assumed answer"];
    if (entry.fields.length !== names.length) {
      problem(`${where}: expected exactly ${names.length} fields (${names.join(", ")}), found ${entry.fields.length} lines`);
    }
    const values = names.map((name, i) => field(entry.fields[i], name));
    names.forEach((name, i) => {
      if (values[i] === null) problem(`${where}: field ${i + 1} should be "- **${name}:** ..." with a value`);
    });
    const importance = values[0] ?? "";
    if (values[0] !== null && !IMPORTANCE.has(importance)) {
      problem(`${where}: importance "${importance}" is not High, Medium or Low`);
    }
    requirements.push({ id: entry.id, importance });
  }
  if (requirements.length === 0) problem(`${path}: no requirements found`);
  return requirements;
}

// "3 (a time limit)": a score from 1 to 3 followed by a short explanation in brackets. Only the
// number is checked against the scale; whether the explanation fits it is for the reader to judge.
function score(value: string | null, where: string, name: string): number {
  const match = value === null ? null : /^([1-3]) \((.+)\)$/.exec(value);
  if (!match) {
    problem(`${where}: ${name} should be 1, 2 or 3 followed by a short explanation in brackets`);
    return 0;
  }
  return Number(match[1]);
}

function readStrategy(path: string): {
  scalesOk: boolean;
  risks: Risk[];
  table: string[][];
  totals: string | null;
} {
  const lines = readLines(path, "strategy");
  const found = sections(path, lines, RISK_SECTIONS);

  // The scales: both must be stated, each with a defined level 3, 2 and 1.
  let scalesOk = true;
  const scoring = found.get("How risks are scored");
  if (!scoring) {
    problem(`${path}: no "## How risks are scored" section`);
    scalesOk = false;
  } else {
    for (const scale of ["Likelihood", "Impact"]) {
      const start = scoring.lines.findIndex((line) => line.startsWith(`**${scale}**`));
      if (start < 0) {
        problem(`${path}: the ${scale.toLowerCase()} scale is not stated`);
        scalesOk = false;
        continue;
      }
      const levels: string[] = [];
      for (const line of scoring.lines.slice(start + 1)) {
        if (line.startsWith("**")) break;
        const level = /^- \*\*([1-3]):\*\* \S/.exec(line);
        if (level?.[1]) levels.push(level[1]);
      }
      if (levels.join(",") !== "3,2,1") {
        problem(`${path}: the ${scale.toLowerCase()} scale should define levels 3, 2 and 1 in that order (found ${levels.join(", ") || "none"})`);
        scalesOk = false;
      }
    }
  }

  // Every risk entry, in whichever risk section it sits.
  const risks: Risk[] = [];
  for (const name of RISK_SECTIONS) {
    const section = found.get(name);
    if (!section) {
      problem(`${path}: no "## ${name}" section`);
      continue;
    }
    for (const entry of entries(path, section, /^R-\d{2}$/, true)) {
      const where = `${path} ${entry.id} (line ${entry.line})`;
      const names = ["Requirement", "Risk", "Likelihood", "Impact", "Layer", "Reason"];
      if (name === UNTESTED_SECTION) names.push("Accepted by");
      if (entry.fields.length !== names.length) {
        problem(`${where}: expected exactly ${names.length} fields (${names.join(", ")}), found ${entry.fields.length} lines`);
      }
      const values = names.map((fieldName, i) => field(entry.fields[i], fieldName));
      names.forEach((fieldName, i) => {
        if (values[i] === null) problem(`${where}: field ${i + 1} should be "- **${fieldName}:** ..." with a value`);
      });
      const requirements = (values[0] ?? "").split(", ").filter((id) => id !== "");
      const layer = values[4] ?? "";
      if (values[4] !== null && !(LAYERS as readonly string[]).includes(layer)) {
        problem(`${where}: layer "${layer}" is not exactly one of ${LAYERS.join(", ")}`);
      }
      risks.push({
        id: entry.id,
        section: name,
        requirements,
        likelihood: score(values[2] ?? null, where, "likelihood"),
        impact: score(values[3] ?? null, where, "impact"),
        layer: layer as Layer,
        reason: values[5] ?? "",
        acceptedBy: values[6] ?? "",
      });
    }
  }

  // The ranking table: every row after the header and its divider.
  const table: string[][] = [];
  const ranking = found.get("Ranking");
  let totals: string | null = null;
  if (!ranking) {
    problem(`${path}: no "## Ranking" section`);
  } else {
    const rows = ranking.lines.filter((line) => line.startsWith("|"));
    const header = "| Rank | Risk | Requirement | Likelihood | Impact | Score | Layer |";
    if (rows[0] !== header) problem(`${path}: the ranking table should start with the header ${header}`);
    if (rows[1] === undefined || !/^\|( *:?-+:? *\|)+$/.test(rows[1])) {
      problem(`${path}: the ranking table's second line should be its divider row`);
    }
    for (const row of rows.slice(2)) {
      table.push(row.split("|").slice(1, -1).map((cell) => cell.trim()));
    }
    const totalsLine = ranking.lines.find((line) => line.startsWith("Totals: "));
    totals = totalsLine === undefined ? null : (totalsLine.slice("Totals: ".length).split(". ")[0] ?? "");
  }
  return { scalesOk, risks, table, totals };
}

function words(text: string): number {
  return text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;
}

function main(argv: string[]): number {
  let requirementsPath = DEFAULT_REQUIREMENTS;
  let strategyPath = DEFAULT_STRATEGY;
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`usage: node risk-strategy-check.ts [--requirements <path>] [--strategy <path>]`);
      return 2;
    }
    if (argv[i] === "--requirements") requirementsPath = value;
    else if (argv[i] === "--strategy") strategyPath = value;
    else {
      console.error(`unknown option ${argv[i]}`);
      return 2;
    }
  }

  let requirements: Requirement[];
  let strategy: ReturnType<typeof readStrategy>;
  try {
    requirements = readRequirements(requirementsPath);
    strategy = readStrategy(strategyPath);
  } catch (error) {
    if (error instanceof Unreadable) {
      console.error(`risk-strategy-check ${VERSION}: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const { risks, table, totals } = strategy;
  const known = new Map(requirements.map((r) => [r.id, r]));
  const out: string[] = [];
  const check = (passed: boolean, text: string, details: string[] = []): void => {
    out.push(`${passed ? "PASS" : "FAIL"}  ${text}`);
    for (const line of details) out.push(`      ${line}`);
  };

  out.push(`risk-strategy-check ${VERSION}`);
  out.push(`requirements: ${requirementsPath} (${requirements.length} requirements)`);
  out.push(`strategy: ${strategyPath} (${risks.length} risks)`);

  // Problems found while reading come first: the checks below rely on the files being read whole.
  const readProblems = problems.splice(0);
  check(readProblems.length === 0, "both files are in the expected form", readProblems);

  // Criterion 2 and 7: the scales are stated.
  check(strategy.scalesOk, "the likelihood and impact scales are each stated at 3, 2 and 1");

  // Risk ids and the requirements each risk names.
  const idProblems: string[] = [];
  const seen = new Set<string>();
  for (const risk of risks) {
    if (seen.has(risk.id)) idProblems.push(`${risk.id} is used more than once`);
    seen.add(risk.id);
    if (risk.requirements.length === 0) idProblems.push(`${risk.id} names no requirement`);
    for (const id of risk.requirements) {
      if (!known.has(id)) idProblems.push(`${risk.id} names ${id}, which is not in the requirements`);
    }
    if (new Set(risk.requirements).size !== risk.requirements.length) {
      idProblems.push(`${risk.id} names the same requirement twice`);
    }
  }
  check(idProblems.length === 0, `every risk has its own id and names only known requirements`, idProblems);

  // Criterion 3: one layer per risk.
  const badLayer = risks.filter((r) => !(LAYERS as readonly string[]).includes(r.layer));
  check(
    risks.length > 0 && badLayer.length === 0,
    `every risk has exactly one layer from ${LAYERS.join(", ")}`,
    badLayer.map((r) => `${r.id}: "${r.layer}"`),
  );

  // Criterion 4: a reason, not only a label.
  const thin = risks.filter((r) => words(r.reason) < MIN_REASON_WORDS);
  check(
    risks.length > 0 && thin.length === 0,
    `every risk gives a reason of at least ${MIN_REASON_WORDS} words for its layer`,
    thin.map((r) => `${r.id}: ${words(r.reason)} words`),
  );

  // Criterion 1: every requirement appears in the strategy.
  const coverage: string[] = [];
  const missing: string[] = [];
  for (const requirement of requirements) {
    const covering = risks
      .filter((r) => r.requirements.includes(requirement.id))
      .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    if (covering.length === 0) {
      missing.push(`${requirement.id}: not in the strategy`);
    } else {
      const tested = covering.some((r) => r.layer !== "untested");
      coverage.push(
        `${requirement.id}: ${covering.map((r) => `${r.id} ${r.layer}`).join(", ")}${tested ? "" : " (untested only, listed)"}`,
      );
    }
  }
  check(
    requirements.length > 0 && missing.length === 0,
    `every requirement appears in the strategy (${requirements.length - missing.length} of ${requirements.length})`,
    [...missing, ...coverage],
  );

  // Criterion 5: browser risks kept apart from the rest.
  const misplaced = risks.filter((r) => !(SECTION_LAYERS[r.section] ?? []).includes(r.layer));
  const count = (section: string) => risks.filter((r) => r.section === section).length;
  check(
    misplaced.length === 0,
    `browser risks are separated: ${count(BROWSER_SECTION)} in "${BROWSER_SECTION}", ` +
      `${count(NO_BROWSER_SECTION)} in "${NO_BROWSER_SECTION}", no UI layer outside the browser section`,
    misplaced.map((r) => `${r.id} has layer ${r.layer} but is in "${r.section}"`),
  );

  // Criterion 6: every untested risk is listed with a reason and who accepted it.
  const untested = risks.filter((r) => r.layer === "untested");
  const unlisted = untested.filter((r) => r.section !== UNTESTED_SECTION || r.acceptedBy === "");
  check(
    unlisted.length === 0,
    `every untested risk is listed in "${UNTESTED_SECTION}" with a reason and who accepted it ` +
      `(${untested.length}: ${untested.map((r) => r.id).join(", ") || "none"})`,
    [
      ...unlisted.map((r) => `${r.id} is untested but not listed with who accepted it`),
      ...untested.filter((r) => r.acceptedBy !== "").map((r) => `${r.id} accepted by ${r.acceptedBy}`),
    ],
  );

  // Criterion 7: rebuild the ranking from the scales and the tie rules, and compare with the table.
  const importance = (risk: Risk): number =>
    Math.max(0, ...risk.requirements.map((id) => IMPORTANCE.get(known.get(id)?.importance ?? "") ?? 0));
  const number = (risk: Risk): number => Number(risk.id.slice(2));
  const rebuilt = [...risks].sort(
    (a, b) =>
      b.likelihood * b.impact - a.likelihood * a.impact ||
      importance(b) - importance(a) ||
      number(a) - number(b),
  );
  const rankProblems: string[] = [];
  if (table.length !== rebuilt.length) {
    rankProblems.push(`the table has ${table.length} rows; the strategy has ${rebuilt.length} risks`);
  }
  rebuilt.forEach((risk, i) => {
    const expected = [
      String(i + 1),
      risk.id,
      risk.requirements.join(", "),
      String(risk.likelihood),
      String(risk.impact),
      String(risk.likelihood * risk.impact),
      risk.layer,
    ];
    const row = table[i];
    if (row === undefined || row.join(" | ") !== expected.join(" | ")) {
      rankProblems.push(`rank ${i + 1} should be | ${expected.join(" | ")} |, the table has ${row ? `| ${row.join(" | ")} |` : "no row"}`);
    }
  });
  check(
    risks.length > 0 && rankProblems.length === 0,
    `the ranking rebuilt from the stated scales matches the table (${table.length} rows)`,
    rankProblems,
  );

  // The totals sentence under the table must agree with the risks.
  const actualTotals = LAYERS.map((layer) => `${risks.filter((r) => r.layer === layer).length} ${layer}`).join(", ");
  check(
    totals === actualTotals,
    `the totals under the table match the risks: ${actualTotals}`,
    totals === actualTotals ? [] : [`the table says: ${totals ?? "no totals line"}`],
  );

  const failed = out.some((line) => line.startsWith("FAIL"));
  out.push(failed ? "RESULT: FAILED" : "RESULT: PASSED");
  console.log(out.join("\n"));
  return failed ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // Anything unexpected is reported as "couldn't check" (2), never as an ordinary FAIL (1).
  console.error(`risk-strategy-check ${VERSION}: stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
