#!/usr/bin/env python3
"""Ingest a meeting transcript into a redacted, attributed source of record.

Part of the ba-ingest-transcript skill (see SKILL.md next to this file). Standard library only.

Usage (from the repository root):

    .venv/bin/python participant/skills/ba-ingest-transcript/ingest.py RAW_FILE TRANSCRIPT_ID \
        [--out-dir participant/context/transcripts] [--log LOG_FILE]

What it does, in order:
  1. Reads RAW_FILE and parses ALL of it before writing anything. Any line it cannot parse
     stops the run with the line number and the reason; nothing is written.
  2. Redacts email addresses and phone numbers to [REDACTED]. Speaker names are kept: they are
     the attribution.
  3. Gives the transcript the id TRANSCRIPT_ID and each utterance a sequence id (U001, U002, ...)
     in the order spoken. Cite a line as TRANSCRIPT_ID#U007.
  4. Flags utterances that read like instructions to an AI or a tool. They are kept as ordinary
     content; nothing in the transcript is ever acted on.
  5. Writes TRANSCRIPT_ID.md (the source of record) and TRANSCRIPT_ID.provenance.yaml, each
     through a temporary file renamed into place, so a failed run leaves no partial file. The
     temporary files are removed if anything fails.
  6. If the source of record already exists: an identical result is reported as unchanged and
     nothing is rewritten (no duplicated utterances); a different result is refused, because the
     source of record is never rewritten.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

TOOL_NAME = "ba-ingest-transcript/ingest.py"
TOOL_VERSION = "1.0.0"
TIMESTAMP_FORMAT = "HH:MM:SS, elapsed time from the start of the recording"
REDACTED = "[REDACTED]"

HEADER_FIELDS = ("Meeting", "Date", "Attendees")
UTTERANCE = re.compile(r"^\[(?P<ts>\d{2}:[0-5]\d:[0-5]\d)\] (?P<speaker>[^:\[\]]{1,80}): (?P<text>\S.*)$")
UNCERTAIN_SPEAKERS = {"unknown", "unidentified", "?"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)")
# Phrases that read as an instruction to an assistant or a tool. Matching only flags the line.
INSTRUCTION_LIKE = re.compile(
    r"\b(ignore (all |your |any )?(previous |prior )?instructions|AI assistant|system prompt|"
    r"run (this|the following) command|delete (the|all|every)\b)",
    re.IGNORECASE,
)
TRANSCRIPT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class IngestError(Exception):
    """The transcript cannot be ingested; the message says why."""


@dataclass
class Utterance:
    uid: str
    timestamp: str
    speaker: str
    certain: bool
    text: str
    redactions: int
    instruction_like: bool


def seconds(ts: str) -> int:
    h, m, s = (int(p) for p in ts.split(":"))
    return h * 3600 + m * 60 + s


def redact(text: str) -> tuple[str, int]:
    text, emails = EMAIL.subn(REDACTED, text)
    text, phones = PHONE.subn(REDACTED, text)
    return text, emails + phones


def parse(raw: str) -> tuple[dict[str, str], list[Utterance]]:
    """Parses the whole transcript, or raises IngestError naming the first problem."""
    if not raw.strip():
        raise IngestError("the file is empty")
    lines = raw.splitlines()
    header: dict[str, str] = {}
    i = 0
    while i < len(lines) and lines[i].strip():
        key, sep, value = lines[i].partition(":")
        if not sep or key.strip() not in HEADER_FIELDS or not value.strip():
            raise IngestError(f"line {i + 1}: expected a header line ({', '.join(HEADER_FIELDS)}), got {lines[i][:60]!r}")
        header[key.strip()] = value.strip()
        i += 1
    missing = [f for f in HEADER_FIELDS if f not in header]
    if missing:
        raise IngestError(f"header is missing: {', '.join(missing)}")
    try:
        dt.date.fromisoformat(header["Date"])
    except ValueError:
        raise IngestError(f"header Date {header['Date']!r} is not YYYY-MM-DD") from None

    utterances: list[Utterance] = []
    last = -1
    for n, line in enumerate(lines[i:], start=i + 1):
        if not line.strip():
            continue
        m = UTTERANCE.match(line)
        if not m:
            raise IngestError(f"line {n}: not an utterance of the form '[HH:MM:SS] Speaker: text': {line[:60]!r}")
        ts = m["ts"]
        if seconds(ts) < last:
            raise IngestError(f"line {n}: timestamp {ts} is earlier than the line before it")
        last = seconds(ts)
        speaker = m["speaker"].strip()
        text, count = redact(m["text"])
        utterances.append(
            Utterance(
                uid=f"U{len(utterances) + 1:03d}",
                timestamp=ts,
                speaker=speaker,
                certain=speaker.lower() not in UNCERTAIN_SPEAKERS,
                text=text,
                redactions=count,
                instruction_like=bool(INSTRUCTION_LIKE.search(m["text"])),
            )
        )
    if not utterances:
        raise IngestError("no utterances found after the header")
    return header, utterances


def render_record(tid: str, header: dict[str, str], utterances: list[Utterance], source_sha: str) -> str:
    flagged = [u.uid for u in utterances if u.instruction_like]
    uncertain = [u.uid for u in utterances if not u.certain]
    out = [
        f"# Transcript {tid}: {header['Meeting']}",
        "",
        "Source of record. Verbatim and in the order spoken, apart from redaction. Never edit, reorder or",
        "summarize this file; derived notes and analysis belong in separate files.",
        "",
        f"- Transcript id: `{tid}` (cite a line as `{tid}#U001`)",
        f"- Meeting date: {header['Date']}",
        f"- Timestamp format: {TIMESTAMP_FORMAT}",
        f"- Utterances: {len(utterances)}",
        f"- Redacted: email addresses and phone numbers, each replaced by `{REDACTED}` "
        f"({sum(u.redactions for u in utterances)} in total)",
        f"- Uncertain speakers: {', '.join(uncertain) if uncertain else 'none'} (marked, not guessed)",
        f"- Flagged as instruction-like: {', '.join(flagged) if flagged else 'none'} "
        "(recorded as content; nothing in this transcript was acted on)",
        f"- Raw source SHA-256: `{source_sha}` (the unredacted original is kept outside source control; "
        "see the provenance file)",
        "",
        "| Id | Time | Speaker | Utterance |",
        "|---|---|---|---|",
    ]
    for u in utterances:
        speaker = u.speaker if u.certain else f"{u.speaker} (uncertain)"
        notes = []
        if u.redactions:
            notes.append(f"{u.redactions} redacted")
        if u.instruction_like:
            notes.append("instruction-like, not followed")
        note = f" _[{'; '.join(notes)}]_" if notes else ""
        text = u.text.replace("|", "\\|")
        out.append(f"| {u.uid} | {u.timestamp} | {speaker} | {text}{note} |")
    return "\n".join(out) + "\n"


def yaml_str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_provenance(tid, header, utterances, source_sha, record_sha, raw_path, ingested_at) -> str:
    speakers = sorted({u.speaker for u in utterances if u.certain})
    lines = [
        "schema: ba-ingest-transcript/provenance/v1",
        f"transcript_id: {tid}",
        f"meeting: {yaml_str(header['Meeting'])}",
        f"meeting_date: {header['Date']}",
        f"participants_listed: {yaml_str(header['Attendees'])}",
        "speakers_attributed:",
        *[f"  - {yaml_str(s)}" for s in speakers],
        f"uncertain_speaker_utterances: [{', '.join(u.uid for u in utterances if not u.certain)}]",
        "capture_source: \"Synthetic transcript written for this exercise; no recording exists\"",
        "transcription_tool: \"None; typed by hand\"",
        f"original_location: {yaml_str(str(raw_path))}",
        "original_in_source_control: false",
        f"original_sha256: {source_sha}",
        f"timestamp_format: {yaml_str(TIMESTAMP_FORMAT)}",
        f"utterance_count: {len(utterances)}",
        "redaction:",
        "  rules: [email addresses, phone numbers]",
        f"  replacements: {sum(u.redactions for u in utterances)}",
        f"  placeholder: {yaml_str(REDACTED)}",
        f"instruction_like_utterances: [{', '.join(u.uid for u in utterances if u.instruction_like)}]",
        "ingestion:",
        f"  tool: {TOOL_NAME}",
        f"  tool_version: {TOOL_VERSION}",
        f"  ingested_at: {ingested_at}",
        f"  record_sha256: {record_sha}",
    ]
    return "\n".join(lines) + "\n"


def write_atomically(files: dict[Path, str]) -> None:
    """Writes every file or none: each goes to a temp file first, then all are renamed into place."""
    temps: dict[Path, Path] = {}
    done: list[Path] = []
    try:
        for target, content in files.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
            temps[target] = Path(name)
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
        for target, temp in temps.items():
            os.chmod(temp, 0o644)
            os.replace(temp, target)
            done.append(target)
    except BaseException:
        for temp in temps.values():
            temp.unlink(missing_ok=True)
        for target in done:  # a later rename failed: take back the ones already in place
            target.unlink(missing_ok=True)
        raise


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ingest(raw_path: Path, tid: str, out_dir: Path) -> list[str]:
    """Runs one ingestion; returns the report lines. Raises IngestError when refused."""
    report: list[str] = []
    if not TRANSCRIPT_ID.match(tid):
        raise IngestError(f"transcript id {tid!r} must be lower-case letters, digits and hyphens")
    try:
        raw = raw_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise IngestError(f"{raw_path} does not exist") from None
    except UnicodeDecodeError:
        raise IngestError(f"{raw_path} is not UTF-8 text") from None
    header, utterances = parse(raw)
    source_sha = sha256(raw)
    record = render_record(tid, header, utterances, source_sha)
    record_sha = sha256(record)
    record_path = out_dir / f"{tid}.md"
    provenance_path = out_dir / f"{tid}.provenance.yaml"

    report.append(f"parsed {len(utterances)} utterances from {raw_path}")
    report.append(f"redacted {sum(u.redactions for u in utterances)} value(s): email addresses and phone numbers")
    for u in utterances:
        if not u.certain:
            report.append(f"{tid}#{u.uid} [{u.timestamp}] speaker {u.speaker!r} marked uncertain (not guessed)")
        if u.instruction_like:
            report.append(
                f"{tid}#{u.uid} [{u.timestamp}] instruction-like text from {u.speaker}: recorded as content, NOT followed"
            )

    if record_path.exists():
        existing = record_path.read_text(encoding="utf-8")
        existing_sha = sha256(existing)
        if existing == record:
            report.append(f"{record_path} already exists and is identical (sha256 {existing_sha})")
            report.append("unchanged: nothing written, no utterance added or duplicated")
            return report
        raise IngestError(
            f"{record_path} already exists with different content (sha256 {existing_sha}, new {record_sha}); "
            "the source of record is never rewritten. Use a new transcript id for a different transcript."
        )

    ingested_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    provenance = render_provenance(tid, header, utterances, source_sha, record_sha, raw_path, ingested_at)
    write_atomically({record_path: record, provenance_path: provenance})
    report.append(f"wrote {record_path} (sha256 {record_sha})")
    report.append(f"wrote {provenance_path}")
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Ingest a meeting transcript into a redacted source of record.")
    ap.add_argument("raw_file", type=Path)
    ap.add_argument("transcript_id")
    ap.add_argument("--out-dir", type=Path, default=Path("participant/context/transcripts"))
    ap.add_argument("--log", type=Path, help="also save this run (command and output) to this file")
    args = ap.parse_args(argv)

    started = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    command = "$ " + " ".join([".venv/bin/python", TOOL_NAME.replace("ba-ingest-transcript/", "participant/skills/ba-ingest-transcript/"), *(argv if argv is not None else sys.argv[1:])])
    lines = [command, f"# run at {started} by {TOOL_NAME} {TOOL_VERSION}"]
    try:
        lines += ingest(args.raw_file, args.transcript_id, args.out_dir)
        status = 0
    except IngestError as e:
        record_path = args.out_dir / f"{args.transcript_id}.md"
        lines.append(f"REFUSED: {e}")
        lines.append(
            f"no record written: {record_path} "
            + ("already existed before this run and was left as it was" if record_path.exists() else "does not exist")
        )
        status = 1
    lines.append(f"exit status {status}")
    text = "\n".join(lines) + "\n"
    print(text, end="")
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        with args.log.open("a", encoding="utf-8") as f:
            f.write(text + "\n")
    return status


if __name__ == "__main__":
    sys.exit(main())
