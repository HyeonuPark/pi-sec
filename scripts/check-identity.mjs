// Check that commit identities are in the list of an install.
//
//   node scripts/check-identity.mjs --identities <file> '<Name> <email>' ...
//
// The file holds one identity per line as `Name <email>`, compared as an exact
// line. Blank lines and lines starting with `#` are ignored. The script prints
// nothing for a listed identity and never prints an identity that is not listed.
// Exit codes: 0 when every identity is listed, 1 when one is not, 2 for a usage
// error, such as a missing option or a file that cannot be read.
import { readFileSync } from "node:fs";

const USAGE = "usage: node scripts/check-identity.mjs --identities <file> '<Name> <email>' ...";

function fail(message, code) {
  process.stderr.write(`check-identity: ${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
let file;
const identities = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--identities") {
    file = args[index + 1];
    if (file === undefined) fail(`--identities needs a value\n${USAGE}`, 2);
    index += 1;
  } else if (arg.startsWith("--")) {
    fail(`unknown argument: ${arg}\n${USAGE}`, 2);
  } else {
    identities.push(arg);
  }
}
if (file === undefined || identities.length === 0) fail(USAGE, 2);

let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  fail(`cannot read the identity file ${file}`, 2);
}
const listed = new Set();
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) continue;
  listed.add(line);
}
const unlisted = identities.filter((identity) => !listed.has(identity.trim()));
if (unlisted.length > 0) fail(`${unlisted.length} identity not in ${file}`, 1);
