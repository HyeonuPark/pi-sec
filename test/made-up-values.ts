/**
 * Inputs that the shape rules of `scripts/scan-tree.mjs` must refuse, built when
 * a test runs.
 *
 * No committed file holds a real-looking id or address: the scan of this
 * repository and the pre-commit hook would report this file, and a real value of
 * any install must never be a fixture.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID-shaped token with no run of six equal characters, built at run time. */
export function madeUpUlid(seed = 1): string {
  let out = "0";
  for (let index = 1; index < 26; index += 1) out += CROCKFORD[(seed * 7 + index * 5) % 32];
  return out;
}

/** An address on a domain that is not an example domain; the domain is a made-up word. */
export function madeUpAddress(): string {
  return ["person", "zebra-quartz.co.uk"].join("@");
}

/** Lines that the shape rules must report. */
export function mustFail(): string[] {
  return [
    madeUpUlid(1),
    madeUpUlid(2).toLowerCase(),
    `20300115-${madeUpUlid(3).toLowerCase()}-fix-hook`,
    madeUpAddress(),
  ];
}

/** Lines that the shape rules must pass. */
export const MUST_PASS: readonly string[] = [
  "01KA00000000000000000000E1",
  "0123456789abcdef0123456789abcdef01234567",
  "a@example.com",
  "b@x.example",
  "pi-sec@localhost",
  "test <test@example.com>",
];

/** The identity that the hook tests list, and one that they do not. */
export const LISTED_IDENTITY = "test <test@example.com>";
export const UNLISTED_IDENTITY = "zebra <zebra@example.com>";
