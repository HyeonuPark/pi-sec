import { afterEach, describe, expect, it } from "vitest";
import { checkDocument } from "../../src/extensions/linear/document.ts";
import { READ_DOCUMENTS } from "../../src/extensions/linear/reads.ts";
import { WRITE_DOCUMENTS } from "../../src/extensions/linear/writes.ts";
import { createRig, reply, type Rig } from "./helpers.ts";

describe("the operation check: what a read may send", () => {
  const passes: Record<string, string> = {
    "a query": "query Q { viewer { id } }",
    "the short form": "{ viewer { id } }",
    "a query with a fragment": "query Q { viewer { ...F } } fragment F on User { id name }",
    "a string that holds mutation": 'query Q { issues(filter: { title: { contains: "mutation { x }" } }) { nodes { id } } }',
    "a block string that holds mutation": 'query Q { issues(filter: { title: { contains: """mutation { x }""" } }) { nodes { id } } }',
    "a comment that holds mutation": "# mutation\nquery Q { viewer { id } }",
    "a field named mutation": "query Q { viewer { mutation } }",
    "a variable with an object default": "query Q($f: IssueFilter = { title: { eq: \"a\" } }) { issues(filter: $f) { nodes { id } } }",
    "an anonymous query with a directive": "query @cached { viewer { id } }",
  };
  for (const [name, document] of Object.entries(passes)) {
    it(`passes ${name}`, () => {
      expect(checkDocument(document, "query")).toEqual({ ok: true });
    });
  }

  it("passes every fixed read document", () => {
    expect(READ_DOCUMENTS.length).toBe(7);
    for (const document of READ_DOCUMENTS) expect(checkDocument(document, "query"), document.slice(0, 40)).toEqual({ ok: true });
  });

  const refused: Record<string, [string, string]> = {
    "a mutation": ["mutation { issueCreate(input: { title: \"x\", teamId: \"x\" }) { success } }", "a mutation"],
    "a named mutation": ["mutation M { issueDelete(id: \"x\") { success } }", "a mutation"],
    "a subscription": ["subscription { issueCreated { id } }", "a subscription"],
    "a query followed by a mutation": ["query Q { viewer { id } } mutation { issueArchive(id: \"x\") { success } }", "a mutation"],
    "a comment line and then a mutation": ["# just a query\nmutation { issueArchive(id: \"x\") { success } }", "a mutation"],
    "a schema definition": ["type Foo { a: Int }", "the word type"],
    "an empty document": ["", "no operation"],
    "a document of only a comment": ["# nothing", "no operation"],
    "two queries": ["query A { viewer { id } } query B { viewer { id } }", "more than one operation"],
    "an unclosed string": ['query Q { issues(filter: { title: { eq: "abc } }) { nodes { id } } }', "text that does not parse"],
    "an unclosed selection set": ["query Q { viewer { id }", "an unclosed selection set"],
    "only a fragment": ["fragment F on User { id }", "no operation"],
  };
  for (const [name, [document, kind]] of Object.entries(refused)) {
    it(`refuses ${name}`, () => {
      const result = checkDocument(document, "query");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toContain(kind);
    });
  }
});

describe("the operation check: what a write may send", () => {
  it("passes each fixed write document only for its own mutation name", () => {
    const names = Object.values(WRITE_DOCUMENTS).map((entry) => entry.mutation);
    expect(names.sort()).toEqual(["commentCreate", "issueCreate", "issueUpdate"]);
    for (const { document, mutation } of Object.values(WRITE_DOCUMENTS)) {
      expect(checkDocument(document, { mutation })).toEqual({ ok: true });
      for (const other of names.filter((name) => name !== mutation)) {
        expect(checkDocument(document, { mutation: other }).ok, `${mutation} as ${other}`).toBe(false);
      }
      // A write document is never a read.
      expect(checkDocument(document, "query")).toEqual({ ok: false, kind: "a mutation" });
    }
  });

  it("refuses a write document with a second top-level field, an alias to another field, or a spread", () => {
    const second = "mutation M($input: IssueCreateInput!) { issueCreate(input: $input) { success } issueDelete(id: \"x\") { success } }";
    expect(checkDocument(second, { mutation: "issueCreate" }).ok).toBe(false);
    const alias = "mutation M { issueCreate: issueDelete(id: \"x\") { success } }";
    expect(checkDocument(alias, { mutation: "issueCreate" }).ok).toBe(false);
    const aliased = "mutation M { made: issueCreate(input: { teamId: \"t\" }) { success } }";
    expect(checkDocument(aliased, { mutation: "issueCreate" })).toEqual({ ok: true });
    const spread = "mutation M { ...F } fragment F on Mutation { issueDelete(id: \"x\") { success } }";
    expect(checkDocument(spread, { mutation: "issueCreate" }).ok).toBe(false);
    expect(checkDocument("query Q { viewer { id } }", { mutation: "issueCreate" }).ok).toBe(false);
  });
});

describe("linear_graphql", () => {
  let rig: Rig | undefined;
  afterEach(async () => {
    await rig?.close();
    rig = undefined;
  });

  const refusedInputs = [
    'mutation { issueCreate(input: { title: "x", teamId: "x" }) { success } }',
    "subscription { issueCreated { id } }",
    "query Q { viewer { id } } mutation { issueArchive(id: \"x\") { success } }",
    "# a comment\nmutation { issueArchive(id: \"x\") { success } }",
    "type Foo { a: Int }",
    "   ",
    "query A { viewer { id } } query B { viewer { id } }",
    'query Q { issues(filter: { title: { eq: "abc } }) { nodes { id } } }',
  ];

  it("refuses each of those documents with the fixed sentence and sends no request", async () => {
    rig = await createRig();
    for (const query of refusedInputs) {
      const result = await rig.call("linear_graphql", { query });
      expect(result.isError, query).toBe(true);
      expect(result.text).toMatch(/^Refused: linear_graphql sends only one read query\. This document holds .+\. Nothing was sent to Linear\.$/);
    }
    expect(rig.linear.seen).toHaveLength(0);
  });

  it("sends a query once, with the key in the header and the endpoint fixed", async () => {
    rig = await createRig();
    rig.linear.on("Q", reply({ data: { viewer: { id: "u1" } } }));
    const result = await rig.call("linear_graphql", { query: "query Q { viewer { id } }", variables: { a: 1 } });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"id": "u1"');
    expect(rig.linear.seen).toHaveLength(1);
    expect(rig.linear.seen[0]).toMatchObject({
      url: "https://api.linear.app/graphql",
      method: "POST",
      authorization: "lin_api_FAKEKEY0123456789",
      variables: { a: 1 },
    });
  });
});
