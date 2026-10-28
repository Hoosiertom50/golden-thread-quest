#!/usr/bin/env python3
"""Checks a clarification-question list: that every question is traceable and changes the work.

Part of the ba-clarification-questions quest. The judgment -- which questions are worth asking,
what the answers could be and what each would lead to -- is a person's, written in questions.md
and dropped.md. This program checks that judgment is complete and traceable:
  - every question cites a finding that exists in the verified findings.md;
  - every question lists at least two answers, each followed by the work it leads to;
  - no two answers to one question are the same text, and no two lead to the same work text;
  - every question is one sentence ending in '?' and at most 25 words;
  - questions are numbered Q-01, Q-02, ... in order, with no gaps, and each says why it sits where
    it does (the order is by how much of the work depends on the answer);
  - every dropped question cites a finding that exists and says why its answer changes nothing;
  - every finding is accounted for: asked, dropped, or both (a question rewritten into a better one).
Anything it can't read or doesn't recognise is a problem, never skipped: a check that can't be
made counts as failed, so the result is only PASSED when every check really passed.

It can tell that two work lines are different text, not that they are really different work;
that judgment stays with the person, who reads every line.

Read-only: it writes nothing and sends nothing.

    .venv/bin/python participant/tools/check-questions.py \\
        --findings participant/context/ambiguity/findings.md \\
        --questions participant/context/clarification/questions.md \\
        --dropped participant/context/clarification/dropped.md
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import re
import sys
import unicodedata
from pathlib import Path

VERSION = "1.4.0"
MAX_QUESTION_WORDS = 25
MIN_ANSWERS = 2

FINDING_ID = re.compile(r"^F-\d+$")
FIELD = re.compile(r"^- \*\*([^*]+?):\*\*\s*(.*)$")
HEADING = re.compile(r"^(#{1,6})\s*(.*?)\s*$")
QUOTED_TEXT = re.compile(r'"[^"]*"|“[^”]*”')
ABBREVIATIONS = re.compile(r"(?<!\w)(?:e\.g|i\.e|etc|vs|approx|a\.m|p\.m)\.", re.IGNORECASE)
# Dotted initialisms ("U.S.", "Q.A.") are one word, not the end of a sentence.
INITIALISMS = re.compile(r"(?<!\w)(?:[A-Za-z]\.){2,}")
# A sentence ends at '.', '!' or '?', perhaps followed by closing brackets or quote marks, then a
# space and more text, or directly a capital letter ("failed.Can ...", "(It failed.) Can ...").
# A decimal ("2.50") or a file name ("findings.md") is not a break.
SENTENCE_BREAK = re.compile(r"[.!?][)\]\"'\u201d\u2019]*(?:\s+\S|[A-Z])")
WORD = re.compile(r"[\w'’-]+")
HAS_LETTER_OR_DIGIT = re.compile(r"[^\W_]")
# Above the list section the file is prose. Every kind of formatting is set aside before checking
# -- heading marks, bullets ("-", "*", "+", "1.", "1)"), quote marks, bold, italics and code marks --
# so an entry or field is caught however it is dressed up, alone or in combination.
LEAD_MARKERS = re.compile(r"^(?:#{1,6}\s*|(?:[-*+]|\d+[.)])\s+|>\s*)")
ALL_INLINE_MARKS = re.compile(r"[*_`~]")
# Web markup in a Markdown file: a tag ("<span>") or a character code ("&nbsp;", "&#32;").
HTML_TAG = re.compile(r"</?[A-Za-z][^>]*>")
FIELD_NAMES = ("Finding", "Question", "Answer", "Work", "Why this position", "Why it changes nothing")
# A field label is caught however it is written: bold or not, colon inside or outside the bold.
FIELD_LABEL = re.compile(
    r"^(?:\*\*|__)?\s*(?:" + "|".join(re.escape(f) for f in FIELD_NAMES) + r")\s*(?:\*\*|__)?\s*:",
    re.IGNORECASE,
)
# Emphasis and code marks change how text looks, not what it says. An underscore inside a word
# ("gift_card") is part of the word, so only underscores at a word's edge count as marks.
INLINE_MARKS = re.compile(r"[*`~]|(?<![^\W_])_|_(?![^\W_])")
# Four spaces or a tab at the start of a line make it a code block when the file is shown.
CODE_INDENT = re.compile(r"^(?: {4}|\t| {0,3}\t)")

# Each list file: its section heading, its entry id prefix, and which fields an entry has.
# 'pairs' fields come as Answer then Work, repeated; every other field appears exactly once.
QUESTIONS = {
    "name": "questions",
    "section": "Questions",
    "prefix": "Q",
    "single": ("Finding", "Question", "Why this position"),
    "pairs": True,
}
DROPPED = {
    "name": "dropped",
    "section": "Dropped",
    "prefix": "D",
    "single": ("Finding", "Question", "Why it changes nothing"),
    "pairs": False,
}


def norm(text: str) -> str:
    """Text compared as a reader sees it: one form per character, runs of spaces as one space."""
    return " ".join(unicodedata.normalize("NFC", text).split())


def visible(text: str) -> str:
    """The text as a reader sees it once the file is shown: tags removed, character codes turned
    into the characters they stand for, and no-break spaces as ordinary spaces."""
    return norm(html.unescape(HTML_TAG.sub("", text)).replace("\u00a0", " "))


def bare(text: str) -> str:
    """A line with all its formatting set aside, for spotting entries and fields above the list."""
    text = visible(text)
    while True:
        shorter = LEAD_MARKERS.sub("", text, count=1).lstrip()
        if shorter == text:
            break
        text = shorter
    return ALL_INLINE_MARKS.sub("", text).strip()


def has_content(text: str) -> bool:
    """True when a field says something: a letter or digit once formatting marks are set aside,
    so a dash or an empty code mark doesn't count as a filled-in field."""
    return bool(HAS_LETTER_OR_DIGIT.search(INLINE_MARKS.sub("", text)))


def same_text(a: str, b: str) -> bool:
    """True when two lines say the same thing word for word, ignoring case, emphasis marks and end
    punctuation: '**No.**' and 'No.' read the same to a person."""
    def plain(text: str) -> str:
        return norm(INLINE_MARKS.sub("", text)).casefold().rstrip(" .!?;:")
    return plain(a) == plain(b)


def read_lines(path: Path) -> list[str]:
    """The file's lines. Exits with status 2 if it can't be read as UTF-8 text."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        print(f"Can't read {path}: {exc}", file=sys.stderr)
        sys.exit(2)
    return text.splitlines()


def load_findings_reader(root: Path):
    """The verified quest's own findings parser, so 'a finding exists' means what it meant there."""
    path = root / "participant/tools/check-findings.py"
    spec = importlib.util.spec_from_file_location("check_findings", path)
    if spec is None or spec.loader is None:
        print(f"Can't load {path}", file=sys.stderr)
        sys.exit(2)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except (OSError, SyntaxError) as exc:
        print(f"Can't load {path}: {exc}", file=sys.stderr)
        sys.exit(2)
    return module


def parse_list(lines: list[str], kind: dict, problems: list[str]) -> list[dict]:
    """The entries under '## <section>', in file order. Anything unrecognised is a problem."""
    name, prefix = kind["name"], kind["prefix"]
    entry_heading = re.compile(rf"^### ({prefix}-\d+)\s*$")
    entry_like = re.compile(rf"^(?:#{{1,6}}\s*(?:\*\*)?\s*|\*\*\s*|- \*\*\s*)?{prefix}-\d+\b")
    entries: list[dict] = []
    current: dict | None = None
    in_section = False
    sections_seen = 0
    in_fence = False

    for n, raw in enumerate(lines, 1):
        line = raw.rstrip()
        stripped = line.strip()
        where = f"{name} line {n}"
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            # A code block is never read, so anything in it would go unchecked: report it,
            # in the introduction as well as in the list.
            problems.append(f"{where}: a code block isn't read; write entries as plain fields")
            continue
        if in_fence:
            problems.append(f"{where}: text inside a code block isn't read: {stripped[:60]!r}")
            continue
        if not stripped:
            continue
        if CODE_INDENT.match(raw):
            # An indented line is shown as code, not as a heading or a field, so it is never read.
            unmarked = bare(stripped)
            if in_section or HEADING.match(stripped) or entry_like.match(unmarked) or FIELD_LABEL.match(unmarked):
                problems.append(f"{where}: an indented line is a code block and isn't read: {stripped[:60]!r}")
            continue
        if "<!--" in stripped:
            # A comment is hidden when the file is shown, so a reader would never see what it holds.
            problems.append(f"{where}: a hidden comment; write it as visible text or remove it")
            continue
        heading = HEADING.match(stripped)

        if not in_section:
            if heading and len(heading.group(1)) == 2 and heading.group(2) == kind["section"]:
                in_section = True
                sections_seen += 1
                continue
            # The introduction is prose. Entries or fields up here would never be checked.
            unmarked = bare(stripped)
            if entry_like.match(unmarked) or FIELD_LABEL.match(unmarked):
                problems.append(f"{where}: list content before '## {kind['section']}': {stripped[:60]!r}")
            continue

        if heading:
            level = len(heading.group(1))
            m = entry_heading.match(stripped)
            if m:
                current = {"id": m.group(1), "line": n, "fields": []}
                entries.append(current)
                continue
            if level <= 2 and heading.group(2) == kind["section"]:
                sections_seen += 1
                problems.append(f"{where}: a second '## {kind['section']}' section")
                current = None
                continue
            problems.append(f"{where}: heading that isn't an entry ('### {prefix}-NN'): {stripped[:60]!r}")
            current = None
            continue

        field = FIELD.match(stripped)
        if field and raw.startswith("- "):
            if current is None:
                problems.append(f"{where}: field outside any entry: {stripped[:60]!r}")
                continue
            # Values are checked as a reader sees them, so markup can't fill a blank field or make
            # a copy look different.
            current["fields"].append((field.group(1).strip(), visible(field.group(2)), n))
            continue
        if entry_like.match(stripped):
            problems.append(f"{where}: entry not in the form '### {prefix}-NN': {stripped[:60]!r}")
            continue
        problems.append(f"{where}: text that isn't a field ('- **Name:** value' on one line): {stripped[:60]!r}")

    if sections_seen == 0:
        problems.append(f"{name}: no '## {kind['section']}' section")
    return entries


def check_question_text(text: str, where: str, limit: int | None) -> list[str]:
    """A question is one sentence ending in '?', and short enough to answer without a meeting."""
    found = []
    if not text:
        return [f"{where}: the question is empty"]
    plain = INITIALISMS.sub("abbr", ABBREVIATIONS.sub("abbr", QUOTED_TEXT.sub('"q"', norm(text))))
    if not plain.endswith("?"):
        found.append(f"{where}: the question doesn't end with '?'")
    if plain.count("?") > 1 or SENTENCE_BREAK.search(plain):
        found.append(f"{where}: the question is more than one sentence")
    words = len([w for w in WORD.findall(norm(text)) if HAS_LETTER_OR_DIGIT.search(w)])
    if words == 0:
        found.append(f"{where}: the question has no words")
    if limit is not None and words > limit:
        found.append(f"{where}: the question is {words} words; the limit is {limit}")
    return found


def check_entry(entry: dict, kind: dict, finding_ids: set[str]) -> tuple[dict, list[str]]:
    """One entry's parts and its problems."""
    eid = entry["id"]
    found: list[str] = []
    single: dict[str, str] = {}
    pairs: list[tuple[str, str]] = []
    pending_answer: str | None = None

    for fname, value, n in entry["fields"]:
        where = f"{eid} ({kind['name']} line {n})"
        if kind["pairs"] and fname == "Answer":
            if pending_answer is not None:
                found.append(f"{where}: an Answer with no Work line after it")
            pending_answer = value
            if not has_content(value):
                found.append(f"{where}: an Answer with nothing in it")
            continue
        if kind["pairs"] and fname == "Work":
            if pending_answer is None:
                found.append(f"{where}: a Work line with no Answer before it")
            else:
                pairs.append((pending_answer, value))
            pending_answer = None
            if not has_content(value):
                found.append(f"{where}: a Work line with nothing in it")
            continue
        if pending_answer is not None:
            found.append(f"{where}: an Answer with no Work line after it")
            pending_answer = None
        if fname not in kind["single"]:
            found.append(f"{where}: unknown field {fname!r}")
            continue
        if fname in single:
            found.append(f"{where}: {fname} given twice")
            continue
        single[fname] = value
    if pending_answer is not None:
        found.append(f"{eid}: an Answer with no Work line after it")

    for fname in kind["single"]:
        if fname not in single:
            found.append(f"{eid}: no {fname} line")
        elif not has_content(single[fname]):
            found.append(f"{eid}: {fname} is empty")

    finding = single.get("Finding", "")
    if finding:
        if not FINDING_ID.match(finding):
            found.append(f"{eid}: Finding must be one finding id like F-07, not {finding!r}")
        elif finding not in finding_ids:
            found.append(f"{eid}: cites {finding}, which isn't in findings.md")

    limit = MAX_QUESTION_WORDS if kind["pairs"] else None
    if "Question" in single:
        found.extend(check_question_text(single["Question"], eid, limit))

    if kind["pairs"]:
        if len(pairs) < MIN_ANSWERS:
            found.append(f"{eid}: {len(pairs)} answer(s) with their work; at least {MIN_ANSWERS} needed")
        for i in range(len(pairs)):
            for j in range(i + 1, len(pairs)):
                if pairs[i][0] and same_text(pairs[i][0], pairs[j][0]):
                    found.append(f"{eid}: answers {i + 1} and {j + 1} are the same text")
                if pairs[i][1] and same_text(pairs[i][1], pairs[j][1]):
                    found.append(f"{eid}: answers {i + 1} and {j + 1} lead to the same work text")

    parts = {"id": eid, "finding": finding, "question": single.get("Question", ""), "answers": len(pairs)}
    return parts, found


def check_numbering(entries: list[dict], prefix: str, name: str) -> list[str]:
    """Entries are numbered 01, 02, ... in file order: the order on the page is the order asked."""
    found = []
    seen: set[str] = set()
    for i, e in enumerate(entries, 1):
        if e["id"] in seen:
            found.append(f"{name}: {e['id']} is used twice")
        seen.add(e["id"])
        expected = f"{prefix}-{i:02d}"
        if e["id"] != expected:
            found.append(f"{name}: entry {i} is {e['id']}; expected {expected} (numbered in order, no gaps)")
    return found


def shown(path: Path, root: Path) -> str:
    """The path as printed: relative to the repository, so no home folder appears in a log."""
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return path.name


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--findings", type=Path,
                        default=root / "participant/context/ambiguity/findings.md")
    parser.add_argument("--questions", type=Path,
                        default=root / "participant/context/clarification/questions.md")
    parser.add_argument("--dropped", type=Path,
                        default=root / "participant/context/clarification/dropped.md")
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    args = parser.parse_args(argv)

    problems: list[str] = []
    findings_reader = load_findings_reader(root)
    finding_problems: list[str] = []
    raw_findings, _unflagged = findings_reader.parse_findings(read_lines(args.findings), finding_problems)
    problems.extend(f"findings.md: {p}" for p in finding_problems)
    finding_ids: list[str] = []
    for f in raw_findings:
        if f["id"] in finding_ids:
            problems.append(f"findings.md: finding id {f['id']} is used twice")
        else:
            finding_ids.append(f["id"])
    if not finding_ids:
        problems.append("findings.md: no findings to link questions to")

    q_entries = parse_list(read_lines(args.questions), QUESTIONS, problems)
    d_entries = parse_list(read_lines(args.dropped), DROPPED, problems)
    problems.extend(check_numbering(q_entries, "Q", "questions"))
    problems.extend(check_numbering(d_entries, "D", "dropped"))
    if not q_entries:
        problems.append("questions: no questions")

    questions, dropped = [], []
    for e in q_entries:
        parts, found = check_entry(e, QUESTIONS, set(finding_ids))
        questions.append(parts)
        problems.extend(found)
    for e in d_entries:
        parts, found = check_entry(e, DROPPED, set(finding_ids))
        dropped.append(parts)
        problems.extend(found)

    asked = {q["finding"] for q in questions}
    set_aside = {d["finding"] for d in dropped}
    for fid in finding_ids:
        if fid not in asked and fid not in set_aside:
            problems.append(f"{fid} is neither asked nor dropped")

    print(f"# check-questions.py {VERSION}")
    print(f"Findings:  {shown(args.findings, root)}")
    print(f"Questions: {shown(args.questions, root)}")
    print(f"Dropped:   {shown(args.dropped, root)}")
    print()
    print(f"{len(finding_ids)} findings, {len(questions)} questions, {len(dropped)} dropped.")
    print()
    print("Questions, in the order asked:")
    for q in questions:
        print(f"  {q['id']}  {q['finding'] or '?':<5} {q['answers']} answers  {q['question']}")
    print()
    print("Dropped:")
    if dropped:
        for d in dropped:
            print(f"  {d['id']}  {d['finding'] or '?':<5} {d['question']}")
    else:
        print("  (none)")
    print()
    print("By finding:")
    for fid in finding_ids:
        q_ids = [q["id"] for q in questions if q["finding"] == fid]
        d_ids = [d["id"] for d in dropped if d["finding"] == fid]
        parts = []
        if q_ids:
            parts.append("asked " + ", ".join(q_ids))
        if d_ids:
            parts.append("dropped " + ", ".join(d_ids))
        print(f"  {fid:<5} {'; '.join(parts) if parts else 'NOT ACCOUNTED FOR'}")
    print()
    if problems:
        print(f"Problems ({len(problems)}):")
        for p in problems:
            print(f"  - {p}")
        print()
        print("result: FAILED (exit status 1)")
        return 1
    print("Checks: every question and dropped question cites a finding in findings.md; every question")
    print(f"has at least {MIN_ANSWERS} answers, each with different work text; every question is one sentence")
    print(f"of at most {MAX_QUESTION_WORDS} words ending in '?'; questions are numbered in order with a reason for")
    print("each position; every dropped question says why it changes nothing; every finding is asked")
    print("or dropped.")
    print()
    print("result: PASSED (exit status 0)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
