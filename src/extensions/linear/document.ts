/**
 * The operation check: every request to Linear passes `checkDocument` before
 * `fetch` is called.
 *
 * The check is a small GraphQL lexer plus a walk over the definitions at the top
 * level of the document. It does not validate GraphQL. It answers two questions:
 * which kinds of operation does the document hold, and, for a mutation, which
 * field does it call. Words inside strings, block strings and comments are never
 * read, so `mutation` in a string, in a comment, or as the name of a field does
 * not make a query a mutation. Only the first word of a top-level definition
 * counts.
 */

/** What a caller allows: one read query, or exactly one named mutation. */
export type AllowedOperation = "query" | { readonly mutation: string };

/** What the check found. `kind` is a phrase that completes "This document holds ...". */
export type DocumentCheck = { readonly ok: true } | { readonly ok: false; readonly kind: string };

interface Token {
  readonly type: "name" | "punct" | "value";
  readonly text: string;
}

const PUNCTUATION = new Set(["{", "}", "(", ")", "[", "]", ":", "@", "!", "=", "|", "&", "$", "..."]);

/** Split a document into tokens. Returns undefined when the text does not lex. */
function lex(document: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  const n = document.length;
  while (i < n) {
    const c = document[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "\uFEFF") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && document[i] !== "\n" && document[i] !== "\r") i++;
      continue;
    }
    if (c === '"') {
      if (document.startsWith('"""', i)) {
        i += 3;
        let closed = false;
        while (i < n) {
          if (document.startsWith('\\"""', i)) {
            i += 4;
            continue;
          }
          if (document.startsWith('"""', i)) {
            i += 3;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) return undefined;
        tokens.push({ type: "value", text: '"""' });
        continue;
      }
      i++;
      let closed = false;
      while (i < n) {
        const d = document[i] as string;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "\n" || d === "\r") return undefined;
        if (d === '"') {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return undefined;
      tokens.push({ type: "value", text: '"' });
      continue;
    }
    if (document.startsWith("...", i)) {
      tokens.push({ type: "punct", text: "..." });
      i += 3;
      continue;
    }
    if (PUNCTUATION.has(c)) {
      tokens.push({ type: "punct", text: c });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(document[j] as string)) j++;
      tokens.push({ type: "name", text: document.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.+-]/.test(document[j] as string)) j++;
      tokens.push({ type: "value", text: document.slice(i, j) });
      i = j;
      continue;
    }
    return undefined;
  }
  return tokens;
}

interface Definition {
  readonly kind: "query" | "mutation" | "subscription" | "fragment";
  /** The fields at the top of the selection set, with an alias resolved to the field it calls. */
  readonly fields: string[];
  /** True when the selection set holds a fragment spread or an inline fragment at its top level. */
  readonly spreads: boolean;
}

/** Walk the top-level definitions. Returns a refusal phrase for text that is not a definition. */
function definitions(tokens: Token[]): Definition[] | string {
  const found: Definition[] = [];
  let i = 0;
  const n = tokens.length;
  while (i < n) {
    const first = tokens[i] as Token;
    let kind: Definition["kind"];
    if (first.type === "punct" && first.text === "{") {
      kind = "query";
    } else if (first.type === "name" && (first.text === "query" || first.text === "mutation" || first.text === "subscription" || first.text === "fragment")) {
      kind = first.text;
    } else {
      return first.type === "name" ? `the word ${first.text} where an operation must start` : "text that is not an operation";
    }
    // Move to the opening brace of the selection set. Braces inside parentheses
    // belong to values (a default or an argument), so they are skipped.
    let parens = 0;
    while (i < n) {
      const token = tokens[i] as Token;
      if (token.type === "punct") {
        if (token.text === "(") parens++;
        else if (token.text === ")") parens--;
        else if (token.text === "{" && parens === 0) break;
      }
      i++;
    }
    if (i >= n) return "an operation with no selection set";
    const fields: string[] = [];
    let spreads = false;
    let depth = 0;
    let parenDepth = 0;
    while (i < n) {
      const at = i;
      const token = tokens[at] as Token;
      i++;
      if (token.type === "punct") {
        if (token.text === "(") parenDepth++;
        else if (token.text === ")") parenDepth--;
        else if (parenDepth === 0 && token.text === "{") depth++;
        else if (parenDepth === 0 && token.text === "}") {
          depth--;
          if (depth === 0) break;
        } else if (parenDepth === 0 && depth === 1 && token.text === "...") spreads = true;
        continue;
      }
      if (depth !== 1 || parenDepth !== 0 || token.type !== "name") continue;
      // A word at the top of the selection set starts a field unless it follows
      // a sigil: `@` names a directive, `:` ends an alias, `...` names a fragment,
      // and `... on` names a type.
      const before = tokens[at - 1];
      if (before !== undefined && before.type === "punct" && (before.text === "@" || before.text === ":" || before.text === "...")) continue;
      const beforeThat = tokens[at - 2];
      if (
        before !== undefined &&
        before.type === "name" &&
        before.text === "on" &&
        beforeThat !== undefined &&
        beforeThat.type === "punct" &&
        beforeThat.text === "..."
      ) {
        continue;
      }
      // `alias: field` calls `field`, so the word after the colon is the field.
      const next = tokens[at + 1];
      const target = tokens[at + 2];
      if (next !== undefined && next.type === "punct" && next.text === ":" && target !== undefined && target.type === "name") {
        fields.push(target.text);
        i = at + 3;
      } else {
        fields.push(token.text);
      }
    }
    if (depth !== 0) return "an unclosed selection set";
    found.push({ kind, fields, spreads });
  }
  return found;
}

/** Check one document against what the caller allows. Nothing here sends a request. */
export function checkDocument(document: string, allowed: AllowedOperation): DocumentCheck {
  const tokens = lex(document);
  if (tokens === undefined) return { ok: false, kind: "text that does not parse" };
  if (tokens.length === 0) return { ok: false, kind: "no operation" };
  const defs = definitions(tokens);
  if (typeof defs === "string") return { ok: false, kind: defs };

  if (allowed === "query") {
    for (const def of defs) {
      if (def.kind === "mutation") return { ok: false, kind: "a mutation" };
      if (def.kind === "subscription") return { ok: false, kind: "a subscription" };
    }
    const operations = defs.filter((def) => def.kind === "query").length;
    if (operations === 0) return { ok: false, kind: "no operation" };
    if (operations > 1) return { ok: false, kind: "more than one operation" };
    return { ok: true };
  }

  if (defs.length !== 1) return { ok: false, kind: defs.length === 0 ? "no operation" : "more than one definition" };
  const only = defs[0] as Definition;
  if (only.kind !== "mutation") return { ok: false, kind: `a ${only.kind}, not the mutation ${allowed.mutation}` };
  if (only.spreads) return { ok: false, kind: "a fragment spread inside a mutation" };
  if (only.fields.length !== 1 || only.fields[0] !== allowed.mutation) {
    return { ok: false, kind: `the fields ${only.fields.join(", ") || "(none)"}, not only ${allowed.mutation}` };
  }
  return { ok: true };
}
