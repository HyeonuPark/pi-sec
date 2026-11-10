import { describe, expect, it } from "vitest";
import type { Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { scanDocumentKeys } from "../src/runtime/storage.ts";

type Query = { scope: unknown; at: string; kind: string };

/** A storage that answers two pages of keys and records every query it gets. */
function twoPages(): { storage: Storage; queries: Query[] } {
  const queries: Query[] = [];
  const storage = {
    scanDocuments: async (query: Query, _limit: number, cursor: unknown) => {
      queries.push(query);
      return cursor === undefined
        ? { items: [{ key: "a" }, { key: "b" }, {}], next: "page-2" }
        : { items: [{ key: "c" }], next: undefined };
    },
  } as unknown as Storage;
  return { storage, queries };
}

describe("scanDocumentKeys", () => {
  it("reads every key of one family across pages, in the scope it is given", async () => {
    const conversation = twoPages();
    const scope = { kind: "conversation", conversationId: "7" } as never;
    expect(await scanDocumentKeys(conversation.storage, "sec.thing", BACKGROUND_CONTEXT, scope)).toEqual(["a", "b", "c"]);
    expect(conversation.queries.map((query) => query.scope)).toEqual([scope, scope]);
    expect(conversation.queries[0]).toMatchObject({ at: "current", kind: "sec.thing" });

    const session = twoPages();
    expect(await scanDocumentKeys(session.storage, "sec.thing", BACKGROUND_CONTEXT)).toEqual(["a", "b", "c"]);
    expect(session.queries.map((query) => query.scope)).toEqual([{ kind: "session" }, { kind: "session" }]);
  });
});
