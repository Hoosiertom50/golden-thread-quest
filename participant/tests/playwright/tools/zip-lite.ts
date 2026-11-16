// A small zip reader and writer for Playwright's trace.zip (the failure-evidence quest), so the copy
// step (copy-failure-bundle.ts) and the check (failure-evidence-check.ts) can look inside a trace
// without another package or a system tool. It understands what Playwright writes: files stored as
// they are (method 0) or compressed (method 8, "deflate"). Anything else (an encrypted member,
// another compression, a zip over 4 GB) is refused with an error rather than skipped, so a check can
// never quietly miss a member it couldn't read.

import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer };

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

export function readZip(zip: Buffer): ZipEntry[] {
  if (zip.length < 22) throw new Error("not a zip file (too short)");
  // The end-of-directory record is in the last 22 bytes, or up to 64 KB earlier if there's a comment.
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file (no end-of-directory record)");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("a zip over 4 GB or with 65,535+ members isn't supported");

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error(`damaged zip: directory entry ${i + 1} not found`);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const packedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 1) throw new Error(`${name}: encrypted members aren't supported`);
    if (packedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      throw new Error(`${name}: members over 4 GB aren't supported`);
    }
    if (zip.readUInt32LE(local) !== LOCAL_HEADER) throw new Error(`${name}: damaged zip (no local header)`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + packedSize > zip.length) throw new Error(`${name}: damaged zip (cut short)`);
    const packed = zip.subarray(start, start + packedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(packed);
    else if (method === 8) data = inflateRawSync(packed);
    else throw new Error(`${name}: compression method ${method} isn't supported`);
    if (data.length !== size) throw new Error(`${name}: damaged zip (size doesn't match)`);
    entries.push({ name, data });
  }
  return entries;
}

export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(DIRECTORY_ENTRY, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, packed);
    directory.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
    if (offset > 0xffffffff) throw new Error("a zip over 4 GB isn't supported");
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

// The member as text, or null if it isn't valid UTF-8 (an image, for example).
export function asText(data: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}
