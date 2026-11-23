"""Check an open-questions file against its transcript, for the quest ba-open-questions.

  python3 participant/tools/check-open-questions.py [--transcript FILE] [--questions FILE]

Defaults: participant/context/transcripts/sample-meeting.md and
participant/context/transcripts/sample-meeting.open-questions.md. Reads both, writes nothing, and
prints PASSED (exit 0) or FAILED (exit 1) with every problem named. What it checks:

- every cited utterance exists, and every quoted phrase appears word for word in it;
- a closed question's answer comes after the line that raised it;
- an open question has no answer recorded, isn't also listed as closed or not counted, and any
  answer-like reply within five lines (by someone else) is explained in its "Why open";
- an owner or due point is either "not stated" or cites a line that states it: the owner must be
  that line's speaker or be named in it (never inferred from who raised the question);
- every line of the transcript with a question mark is sorted into exactly one list;
- the counts match the lists, and the file holds only the allowed sections (no decisions or work);
- the transcript is unchanged since it was committed (compared with git's copy, when there is one).

Transcript and file text are data: nothing in them is followed. Written by Claude (Claude Code)
for Tom Carter, 11-23-2026.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument("--transcript", default=str(ROOT / "participant/context/transcripts/sample-meeting.md"))
ap.add_argument("--questions", default=str(ROOT / "participant/context/transcripts/sample-meeting.open-questions.md"))
args = ap.parse_args()

problems = []


def problem(msg):
    problems.append(msg)


def read(path):
    try:
        return Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as err:
        print(f"FAILED: {Path(path).name} can't be read as UTF-8 text ({type(err).__name__}).")
        sys.exit(1)


# ---- the transcript: one table row per utterance -------------------------------------------------
transcript_text = read(args.transcript)
ROW = re.compile(r"^\| (U\d{3}) \| (\d{2}:\d{2}:\d{2}) \| ([^|]+?) \| (.*?) \|$")
utter = {}  # id -> (speaker, text)
order = []
for line in transcript_text.splitlines():
    m = ROW.match(line)
    if m:
        uid, _, speaker, said = m.groups()
        # The transcript escapes Markdown characters with a backslash; quotes compare the spoken text.
        said = re.sub(r"\\([\\`*_{}\[\]()#+\-.!|>~])", r"\1", said)
        said = re.sub(r"\s*_\([^)]*\)_\s*$", "", said)  # the transcript's own marks, e.g. "_(2 redacted)_"
        if uid in utter:
            problem(f"the transcript has {uid} twice")
        utter[uid] = (speaker.strip(), said.strip())
        order.append(uid)
if not utter:
    print("FAILED: no utterances found in the transcript.")
    sys.exit(1)
pos = {uid: i for i, uid in enumerate(order)}

# The transcript must be the committed source of record, unchanged.
rel = Path(args.transcript).resolve()
try:
    committed = subprocess.run(["git", "-C", str(ROOT), "show", f"HEAD:{rel.relative_to(ROOT)}"],
                               capture_output=True, check=True).stdout.decode("utf-8")
    transcript_note = "unchanged since it was committed" if committed == transcript_text else None
    if transcript_note is None:
        problem("the transcript differs from its committed copy (the source of record must not be edited)")
except (subprocess.CalledProcessError, ValueError):
    transcript_note = "not in git here (not compared)"

# ---- the questions file ----------------------------------------------------------------------------
q_text = read(args.questions)
ALLOWED = {"Counts", "Open questions", "Closed in the meeting", "Not counted", "Compared with the decisions file"}
section = None
entries = []  # dicts: list, id, title, fields{name: value}
counts = {}
titles = 0
for raw_line in q_text.splitlines():
    # A heading indented by up to three spaces is still a heading in Markdown: refused here, so
    # nothing can hide as a continuation. "*" and "+" bullets are read like "-" bullets.
    if re.match(r"^ {1,3}#{1,6}\s", raw_line):
        problem(f'"{raw_line.strip()}" is an indented heading, which this file doesn\'t use')
        continue
    line = re.sub(r"^[*+] ", "- ", raw_line)
    # Only three heading levels exist here: the title (once, first), the sections, and the entries.
    h = re.match(r"^(#{1,6})\s", line)
    if h and len(h.group(1)) not in (1, 2, 3):
        problem(f'"{line}" is a heading level this file doesn\'t use')
        continue
    if h and len(h.group(1)) == 1:
        titles += 1
        if titles > 1 or section is not None:
            problem(f'"{line}" is a second title, or a title after the sections began')
        continue
    if line.startswith("## "):
        section = line[3:].strip()
        if section not in ALLOWED:
            problem(f'section "{section}" isn\'t allowed here (questions only: decisions and work live elsewhere)')
        continue
    if line.startswith("### "):
        if section not in ("Open questions", "Closed in the meeting", "Not counted"):
            problem(f'"{line}" is an entry heading outside the three lists')
            continue
        m = re.match(r"^### ([QCN])(\d+) · (.+)$", line)
        want = {"Open questions": "Q", "Closed in the meeting": "C", "Not counted": "N"}.get(section)
        if not m or m.group(1) != want:
            problem(f'"{line}" isn\'t a {want or "?"}-entry heading for its section')
            continue
        eid = m.group(1) + m.group(2)
        if any(e["id"] == eid for e in entries):
            problem(f"{eid} is used twice")
        entries.append({"list": section, "id": eid, "title": m.group(3), "fields": {}})
        continue
    # Any bullet shaped like a field ("- name: value", whatever its spelling) is read as one, so a
    # field the allowlist doesn't know can't slip past as plain text.
    m = re.match(r"^- ([^:]{1,40}): (.*)$", line)
    if m and section == "Counts":
        if not m.group(2).isdigit():
            problem(f'count "{m.group(1)}" isn\'t a number')
        if m.group(1) in counts:
            problem(f'count "{m.group(1)}" is given twice')
        counts[m.group(1)] = int(m.group(2)) if m.group(2).isdigit() else -1
    elif m and entries and section in ALLOWED - {"Counts", "Compared with the decisions file"}:
        if m.group(1) in entries[-1]["fields"]:
            problem(f'{entries[-1]["id"]}: "{m.group(1)}" is given twice')
        entries[-1]["fields"][m.group(1)] = m.group(2)
    elif line.startswith("  ") and entries and entries[-1]["fields"]:
        last = list(entries[-1]["fields"])[-1]
        entries[-1]["fields"][last] += " " + line.strip()
    elif line.startswith("- ") and section in ("Open questions", "Closed in the meeting", "Not counted"):
        problem(f'"{line}" is a bullet in an entry that isn\'t a field')

CITE = re.compile(r"^(U\d{3}) \"(.+)\"$")
FIELDS = {
    "Open questions": ({"Raised", "Raised by", "Kept open by", "Owner", "Due", "Why open"}, set()),
    "Closed in the meeting": ({"Raised", "Answered"}, set()),
    "Not counted": ({"Raised", "Why not counted"}, set()),
}
for e in entries:
    allowed = FIELDS[e["list"]][0]
    for f in e["fields"]:
        if f not in allowed:
            problem(f'{e["id"]}: "{f}" isn\'t a field of {e["list"].lower()} (allowed: {", ".join(sorted(allowed))})')
# 5: every utterance id and quote anywhere in the file (narrative fields and the comparison too)
# must exist and match: U012 "words" pairs are checked word for word, bare ids must exist.
for m in re.finditer(r"\bU\d{4,}\b", q_text):
    problem(f"{m.group(0)} isn't an utterance id (they are U followed by three digits)")
for m in re.finditer(r"\b(U\d{3})\b(?:\s+\"([^\"]+)\")?", q_text):
    if m.group(1) not in utter:
        problem(f"the file cites {m.group(1)}, which isn't in the transcript")
        continue
    quote = re.sub(r"\s+", " ", m.group(2) or "").strip()  # a quote wrapped across lines
    if quote and quote not in re.sub(r"\s+", " ", utter[m.group(1)][1]):
        problem(f'the file quotes "{quote}" as {m.group(1)}, but it isn\'t word for word there')


def cited(entry, field, required=True):
    """A field of the form U012 "words": the id must exist and the words must be in it."""
    value = entry["fields"].get(field)
    if value is None:
        if required:
            problem(f"{entry['id']}: no {field}")
        return None
    m = CITE.match(value)
    if not m:
        problem(f'{entry["id"]}: {field} must be an utterance id and a quote, like U012 "words"')
        return None
    uid, quote = m.groups()
    if uid not in utter:
        problem(f"{entry['id']}: {field} cites {uid}, which isn't in the transcript")
        return None
    if quote not in utter[uid][1]:
        problem(f'{entry["id"]}: {field}: "{quote}" isn\'t word for word in {uid}')
    return uid


def stated(entry, field):
    """Owner or Due: "not stated", or a value followed by a cited line that states it."""
    value = entry["fields"].get(field)
    if value is None:
        problem(f"{entry['id']}: no {field} (write \"not stated\" when the transcript states none)")
        return
    if value == "not stated":
        return
    m = re.match(r"^(.+?), (U\d{3}) \"(.+)\"$", value)
    if not m:
        problem(f'{entry["id"]}: {field} must be "not stated" or a value, an utterance id and a quote')
        return
    who, uid, quote = m.groups()
    if uid not in utter:
        problem(f"{entry['id']}: {field} cites {uid}, which isn't in the transcript")
        return
    speaker, said = utter[uid]
    if quote not in said:
        problem(f'{entry["id"]}: {field}: "{quote}" isn\'t word for word in {uid}')
    if field == "Owner":
        # The owner must be one of the meeting's speakers, and either say the line or be named in it
        # by a whole word (first name or full name), never a substring of another word.
        if who not in speakers:
            problem(f"{entry['id']}: owner {who} isn't one of the meeting's speakers")
        elif who != speaker and not re.search(r"\b(%s|%s)\b" % (re.escape(who), re.escape(who.split()[0])), said):
            problem(f"{entry['id']}: owner {who} is neither the speaker of {uid} nor named in it (guessed?)")
    if field == "Due":
        # The due value must be the quoted words themselves (so it can't say Friday while citing
        # Wednesday); whether that line sets the answer's deadline is for the reviewer.
        if not re.search(r"(?<![A-Za-z0-9])%s(?![A-Za-z0-9])" % re.escape(who), quote, re.I):
            problem(f"{entry['id']}: due \"{who}\" isn't in its own quote \"{quote}\"")


speakers = {s for s, _ in utter.values() if not s.lower().startswith("unknown")}
raised_by = {}
closing_answers = []  # (closed entry, its answer), checked once every entry has been read
for e in entries:
    uid = cited(e, "Raised")
    if uid:
        if uid in raised_by:
            problem(f"{e['id']}: {uid} is already sorted as {raised_by[uid]}")
        raised_by[uid] = e["id"]
    if e["list"] == "Open questions" and uid:
        rb = e["fields"].get("Raised by", "")
        speaker = utter[uid][0]
        if speaker.lower().startswith("unknown"):
            if not rb.lower().startswith("uncertain speaker"):
                problem(f"{e['id']}: {uid}'s speaker is uncertain in the transcript; Raised by must say so")
        elif not rb.startswith(f"{speaker} ({uid})"):
            problem(f"{e['id']}: Raised by must be {speaker} ({uid}), who said it")
    if e["list"] == "Open questions":
        cited(e, "Kept open by")
        stated(e, "Owner")
        stated(e, "Due")
        if not e["fields"].get("Why open"):
            problem(f"{e['id']}: no reason it is still open")
        if "Answered" in e["fields"]:
            problem(f"{e['id']}: an open question has an answer recorded")
    elif e["list"] == "Closed in the meeting":
        a = cited(e, "Answered")
        quote = CITE.match(e["fields"].get("Answered", "")).group(2) if CITE.match(e["fields"].get("Answered", "")) else ""
        # The answer must be whole sentences of its line (starting where a sentence starts, ending
        # where one ends), so a promise or hedge can't be cut off its front or back.
        if a and quote:
            said = utter[a][1]
            at = said.find(quote)
            starts = at == 0 or (at > 1 and said[at - 2] in ".?!" and said[at - 1] == " ")
            ends = at >= 0 and quote.rstrip()[-1:] in ".?!\"" and (at + len(quote) == len(said) or said[at + len(quote)] == " ")
            if at >= 0 and not (starts and ends):
                problem(f'{e["id"]}: the answer "{quote}" isn\'t whole sentences of {a}')
        if re.search(r"\b(I'll|I will|we'll|we will|let me|should|might|maybe|probably|I think|find out)\b", quote, re.I):
            problem(f"{e['id']}: the answer \"{quote}\" is a promise or a hedge, which doesn't close a question")
        if uid and a and pos[a] <= pos[uid]:
            problem(f"{e['id']}: the answer {a} doesn't come after the question {uid}")
        closing_answers.append((e["id"], a))
    elif e["list"] == "Not counted":
        if not e["fields"].get("Why not counted"):
            problem(f"{e['id']}: no reason it isn't counted")

for cid, a in closing_answers:
    if a and raised_by.get(a, "").startswith("Q"):
        problem(f"{cid}: its answer {a} is the line that raised open question {raised_by[a]}")
# An open question must not be answered by any closed entry, under any id.
open_raises = {utter_id for utter_id, eid in raised_by.items() if eid.startswith("Q")}
for e in entries:
    if e["list"] == "Closed in the meeting" and CITE.match(e["fields"].get("Raised", "")):
        if CITE.match(e["fields"]["Raised"]).group(1) in open_raises:
            problem(f"{e['id']}: its question is also listed as open")

# An open question must not have been answered later. A reply within the next five lines, by someone
# other than the asker, that reads like an answer ("Yes", "Agreed", "Fine", "Exactly" …) must be
# named in the question's "Why open" (saying why it doesn't close it), unless it is already the
# recorded answer to a closed question.
ANSWERLIKE = re.compile(r"^(yes|yeah|yep|no|nope|exactly|agreed|fine|right|correct|sure)\b|\byes\b", re.I)
closed_answers = {CITE.match(e["fields"]["Answered"]).group(1) for e in entries
                  if e["list"] == "Closed in the meeting" and CITE.match(e["fields"].get("Answered", ""))}
for e in entries:
    r = CITE.match(e["fields"].get("Raised", ""))
    if e["list"] != "Open questions" or not r or r.group(1) not in pos:
        continue
    asker = utter[r.group(1)][0]
    for later in order[pos[r.group(1)] + 1: pos[r.group(1)] + 6]:
        speaker, said = utter[later]
        if speaker != asker and ANSWERLIKE.search(said) and later not in closed_answers and not re.search(r"\b%s\b" % later, e["fields"].get("Why open", "")):
            problem(f"{e['id']}: {later} (\"{said[:40]}\") reads like an answer; say in Why open why it doesn't close the question")

# Every line with a question mark is sorted exactly once.
for uid in order:
    if "?" in utter[uid][1] and uid not in raised_by:
        problem(f"{uid} asks a question (\"{utter[uid][1][:60]}\") but isn't in any list")

# A line that declares an open question (with or without a question mark) must be cited by an entry.
# (A mention in a reason doesn't count: the line must raise an entry or be what keeps one open.)
cited_ids = {CITE.match(e["fields"][f]).group(1) for e in entries for f in ("Raised", "Kept open by")
             if CITE.match(e["fields"].get(f, ""))}
for uid in order:
    if re.search(r"open question", utter[uid][1], re.I) and uid not in cited_ids:
        problem(f"{uid} declares an open question (\"{utter[uid][1][:60]}\") but no entry cites it")

# Counts.
lists = {"Open questions": "Q", "Closed in the meeting": "C", "Not counted": "N"}
for name, letter in lists.items():
    n = sum(1 for e in entries if e["id"].startswith(letter))
    if counts.get(name) != n:
        problem(f'count "{name}" says {counts.get(name)}, the list has {n}')

# ---- report --------------------------------------------------------------------------------------
print(f"Transcript: {len(order)} utterances ({sum('?' in utter[u][1] for u in order)} with a question mark); {transcript_note}.")
for name, letter in lists.items():
    picked = [e for e in entries if e["id"].startswith(letter)]
    print(f"{name}: {len(picked)}")
    for e in picked:
        r = CITE.match(e["fields"].get("Raised", ""))
        extra = ""
        if letter == "Q":
            extra = f"; owner {e['fields'].get('Owner', '?').split(',')[0]}; due {e['fields'].get('Due', '?').split(',')[0]}"
        elif letter == "C":
            a = CITE.match(e["fields"].get("Answered", ""))
            extra = f"; answered at {a.group(1) if a else '?'}"
        print(f"  {e['id']} raised at {r.group(1) if r else '?'}{extra}: {e['title']}")
if problems:
    print(f"\nFAILED: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)
print("\nPASSED, structurally: every citation and quote checks out, no answer-like reply near an open")
print("question is unexplained, every owner and due point is stated (by its own line) or marked not")
print("stated, no closing answer is a promise or hedge, and every question-marked or declared question is")
print("sorted once. Whether each call is right in meaning is a person's judgment, reviewed by hand.")
