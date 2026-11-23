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
for line in q_text.splitlines():
    if line.startswith("## "):
        section = line[3:].strip()
        if section not in ALLOWED:
            problem(f'section "{section}" isn\'t allowed here (questions only: decisions and work live elsewhere)')
        continue
    if line.startswith("### "):
        m = re.match(r"^### ([QCN])(\d+) · (.+)$", line)
        want = {"Open questions": "Q", "Closed in the meeting": "C", "Not counted": "N"}.get(section)
        if not m or m.group(1) != want:
            problem(f'"{line}" isn\'t a {want or "?"}-entry heading for its section')
            continue
        entries.append({"list": section, "id": m.group(1) + m.group(2), "title": m.group(3), "fields": {}})
        continue
    m = re.match(r"^- ([A-Z][A-Za-z ]+): (.*)$", line)
    if m and section == "Counts":
        if not m.group(2).isdigit():
            problem(f'count "{m.group(1)}" isn\'t a number')
        counts[m.group(1)] = int(m.group(2)) if m.group(2).isdigit() else -1
    elif m and entries and section in ALLOWED - {"Counts", "Compared with the decisions file"}:
        entries[-1]["fields"][m.group(1)] = m.group(2)
    elif line.startswith("  ") and entries and entries[-1]["fields"]:
        last = list(entries[-1]["fields"])[-1]
        entries[-1]["fields"][last] += " " + line.strip()

CITE = re.compile(r"^(U\d{3}) \"(.+)\"$")


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
    if field == "Owner" and who != speaker and who.split()[0] not in said:
        problem(f"{entry['id']}: owner {who} is neither the speaker of {uid} nor named in it (guessed?)")
    if field == "Due" and not re.search(r"\b(by|before|until|on|monday|tuesday|wednesday|thursday|friday|tomorrow|today|next|week|noon|end of)\b", quote, re.I):
        problem(f"{entry['id']}: due point \"{quote}\" doesn't state a time")


raised_by = {}
for e in entries:
    uid = cited(e, "Raised")
    if uid:
        if uid in raised_by:
            problem(f"{e['id']}: {uid} is already sorted as {raised_by[uid]}")
        raised_by[uid] = e["id"]
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
        if uid and a and pos[a] <= pos[uid]:
            problem(f"{e['id']}: the answer {a} doesn't come after the question {uid}")
        if a and a in raised_by and raised_by.get(a, "").startswith("Q"):
            problem(f"{e['id']}: its answer {a} is the line that raised open question {raised_by[a]}")
    elif e["list"] == "Not counted":
        if not e["fields"].get("Why not counted"):
            problem(f"{e['id']}: no reason it isn't counted")

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
        if speaker != asker and ANSWERLIKE.search(said) and later not in closed_answers and later not in e["fields"].get("Why open", ""):
            problem(f"{e['id']}: {later} (\"{said[:40]}\") reads like an answer; say in Why open why it doesn't close the question")

# Every line with a question mark is sorted exactly once.
for uid in order:
    if "?" in utter[uid][1] and uid not in raised_by:
        problem(f"{uid} asks a question (\"{utter[uid][1][:60]}\") but isn't in any list")

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
print("\nPASSED: every citation and quote checks out, nothing answered is listed as open, every owner")
print("and due point is stated or marked not stated, and every question in the transcript is sorted once.")
