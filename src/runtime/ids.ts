import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeTime(time: number): string {
  let out = "";
  let value = time;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = ENCODING[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits of randomness rendered as 16 base32 characters.
  let out = "";
  for (const byte of bytes) out += ENCODING[byte % 32]!;
  while (out.length < RANDOM_CHARS) out += ENCODING[0]!;
  return out.slice(0, RANDOM_CHARS);
}

/** Generate a ULID string: 48-bit timestamp + 80-bit randomness, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom(randomBytes(RANDOM_CHARS));
}

/**
 * `YYYYMMDD` in local time.
 *
 * Local and not UTC on purpose: the operator reads the store with their own
 * calendar in mind, so a job started at 09:00 should carry today's date even
 * when the machine's UTC offset puts it on the previous day.
 */
export function dayStamp(now: number = Date.now()): string {
  const date = new Date(now);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/**
 * A job's identity: `YYYYMMDD-<ULID>`.
 *
 * The ULID alone already sorts by time. The date half buys nothing for the
 * machine — it is there so a job can be placed by eye while reading the store,
 * and it keeps the whole thing one sortable token.
 */
export function jobId(now: number = Date.now()): string {
  return `${dayStamp(now)}-${ulid(now)}`;
}

const JOB_ID_PATTERN = /^(\d{8})-[0-9A-Z]{26}$/;

/** The date half of a job identity, or `undefined` for an id older than the format. */
export function jobIdDay(id: string): string | undefined {
  const match = JOB_ID_PATTERN.exec(id);
  return match?.[1];
}

/** True for a syntactically valid ULID. */
export function isUlid(value: string): boolean {
  return value.length === 26 && [...value].every((char) => ENCODING.includes(char));
}
