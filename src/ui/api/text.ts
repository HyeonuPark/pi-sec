/**
 * The one request function for a body that is not JSON.
 *
 * `request()` reads a JSON answer, and most routes answer JSON. A report
 * revision is the exception: `/api/reports/:id/versions/:n` answers the markdown
 * itself with `Content-Type: text/markdown` (`src/server/routes/reports.ts`), so
 * a JSON reader would fail on the first character of the text.
 *
 * The rules are `request()`'s, because a page must not have two of them: the
 * path is a route under the mount (`at()` puts the prefix on it), a refusal is
 * thrown as an {@link ApiError} carrying the status and the server's code, and
 * `fetch` is called only from this folder (`test/ui/state-and-sources.test.ts`).
 */
import { ApiError } from "./request.ts";
import { at } from "../mount.ts";

/** Read one route's answer as text, exactly as the server wrote it. */
export async function requestText(path: string, options: { readonly signal?: AbortSignal } = {}): Promise<string> {
  const response = await fetch(at(path), { headers: { Accept: "text/markdown, text/plain, */*" }, signal: options.signal });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, `http_${response.status}`, text === "" ? `the server answered ${response.status}` : text);
  }
  return text;
}
