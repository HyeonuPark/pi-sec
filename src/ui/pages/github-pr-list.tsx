/**
 * The list page's entry module.
 *
 * It answers one question: which pull requests wait on me, and where. The page is
 * served at `/github/pr/`, and it draws in three steps.
 *
 * 1. The bar comes from the page itself. The server writes the viewer, the
 *    repositories and the write switch into a JSON block, so the bar is there
 *    before any request; the server holds all three in memory, so the block costs
 *    no GitHub round trip.
 * 2. The list comes from the page too, when the server had one. The server writes
 *    its cached list into a second block, so the rows are drawn with the page and
 *    not a second later. A page the server had no list for draws the list this tab
 *    kept from an earlier visit; either way the page then asks the server.
 * 3. The stream says when the cached list changed, which happens when the daemon's
 *    own poll found something, or when another tab asked for a forced refresh. A
 *    frame is answered by reading the list again, and the read that started last
 *    is the one that draws, so two answers cannot cross.
 *
 * `⟳ Reload` asks GitHub itself (`?refresh=1`) and is this page's only control that
 * costs a GitHub request per press. A failed read puts the server's own sentence in
 * the strip under the bar and leaves the rows that are drawn where they are.
 */
import { mountAt, mountPage } from "../mount.ts";
import { ErrorBanner } from "../github-pr/banner.tsx";
import { PrSections } from "../github-pr/list-rows.tsx";
import { TopBar } from "../github-pr/topbar.tsx";
import { readMeta } from "../github-pr/blocks.ts";
import { startGithubPrStream } from "../streams/github-pr.ts";
import {
  drawFirstList,
  drawStoredList,
  listAnswer,
  listError,
  listForcing,
  listLoading,
  loadList,
} from "../state/github-pr.ts";

/** The header's facts, read once: one page does not change them while it is open. */
const meta = readMeta();

/** The bar, in the place the shell left for it. */
function Bar() {
  return (
    <TopBar
      viewer={meta.viewer}
      repos={meta.repos}
      loading={listLoading.value}
      forcing={listForcing.value}
      onReload={() => {
        void loadList({ refresh: true });
      }}
    />
  );
}

/** The failure strip, which is always in the page and hidden while it is empty. */
function Banner() {
  return <ErrorBanner error={listError.value} />;
}

/** The list: the sections, or the one line that says the page is still reading. */
function View() {
  const answer = listAnswer.value;
  if (answer === null) return <div class="empty">Loading pull requests…</div>;
  return <PrSections sections={answer.sections} repos={meta.repos.length} />;
}

// The first answer is drawn before any request: the block the server wrote, and
// for a page it wrote none into, the list this tab kept.
drawFirstList();
if (listAnswer.value === null) drawStoredList();
// The bar and the strip are taken over in place: `mountAt` puts the component
// where the shell drew that one element, so the stylesheet's `.topbar` and
// `.error-banner` rules and the ids stay on the elements they name. `#view` is a
// region rather than an element of its own, so the page is drawn inside it.
const bar = document.querySelector("#topbar");
if (bar === null) throw new Error("the list page has no element matching #topbar");
mountAt(bar, <Bar />);
const strip = document.querySelector("#error-banner");
if (strip === null) throw new Error("the list page has no element matching #error-banner");
mountAt(strip, <Banner />);
mountPage("#view", View);

// A frame is one more read. A burst costs one read per frame, and the ticket in
// the state module decides which of two reads in flight may draw.
startGithubPrStream({
  onPrs: () => {
    void loadList();
  },
});

void loadList();
