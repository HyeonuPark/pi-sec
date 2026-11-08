import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import { noticeAddressLines } from "../reports/notice.ts";
import { createInboxItemTx, type InboxInput } from "../jobs/inbox.ts";
import { requireReports, type ExtensionContext } from "./context.ts";

/**
 * The item writer moved to `src/jobs/inbox.ts`, beside the store it writes into.
 *
 * It is re-exported here so that every caller and every test of the `notify` tool
 * keeps the import it had, and so that the tool and the core write the same shape of
 * item through one function.
 */
export { createInboxItemTx };
export type { InboxInput };

/**
 * The operator's words with the report's address under them.
 *
 * The address is what makes the item identifiable once the click is past: if the
 * panel cannot open the report, the slug, the job, and the revision are still on
 * screen. It is the same text a report write puts in its own notice, so the two
 * kinds of item read the same way.
 */
function bodyWithAddress(body: string, lines: readonly string[]): string {
  const written = body.trim();
  return written === "" ? lines.join("\n") : [written, "", ...lines].join("\n");
}

/** The bundled `notify` extension: durable messages to the operator. */
export function createNotifyExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const notify = defineTool({
    name: "notify",
    description:
      "Write a durable notification item to the user's inbox (shown in the UI). Give `reportId` to make the item a report notice: its title opens that report in the chat panel. No revision is written either way.",
    parameters: obj(
      {
        title: str(),
        body: str(),
        kind: opt(str()),
        severity: opt(union([lit("info"), lit("warn"), lit("error")])),
        jobId: opt(str()),
        reportId: opt(
          str({
            description:
              "The id of an existing report this item is about. The item then opens that report in the chat panel, which is how the user reaches the document and the revision to confirm. Nothing is written to the report, so the revision count does not move. An unknown id is refused.",
          }),
        ),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      // A report notice raised here points at a report that already exists, and the
      // lookup is the one `reports_get` makes, so an id that opens nothing is
      // refused instead of becoming an item whose click leads nowhere.
      const asked = args.reportId?.trim();
      const wanted = asked !== undefined && asked !== "";
      const report = wanted ? await requireReports(context).getAny(ctx, asked) : undefined;
      if (wanted && report === undefined) {
        return {
          output: [
            {
              type: "text" as const,
              text: `No report with id ${asked}. Nothing was written. Name a report that exists, or publish one first.`,
            },
          ],
          isError: true,
        };
      }
      const item = await api.commit(
        (tx) =>
          createInboxItemTx(tx, {
            title: args.title,
            body: report === undefined ? args.body : bodyWithAddress(args.body, noticeAddressLines(report)),
            // An item that carries `reportId` is a report notice, and the kind says
            // so: the UI marks the row by the id alone, but the stored item should
            // say what it is to anything that reads the inbox.
            kind: args.kind ?? (report === undefined ? "notice" : "report"),
            severity: args.severity,
            jobId: args.jobId ?? report?.jobId,
            reportId: report?.id,
            conversationId: String(api.conversationId),
          }),
        ctx,
      );
      context.events.emit("inbox_item", item as unknown as Record<string, unknown>);
      context.audit.append({ type: "inbox_item", itemId: item.id, kind: item.kind });
      return { output: [{ type: "text" as const, text: `inbox item ${item.id} created` }] };
    },
  });

  return defineExtension({ name: "notify", tools: [notify] });
}
