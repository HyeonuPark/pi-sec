/**
 * The diff page's entry module.
 *
 * It answers one question: what does this pull request change. The page is an
 * address of its own (`/github/pr/<owner>/<repo>/<number>/diff`), and it draws in the
 * three fixed steps:
 *
 * 1. The bar comes from the page's own JSON block: the viewer, the repositories and
 *    the write switch, which the server holds in memory. The header is therefore
 *    there before the first request.
 * 2. The diff comes from this tab's session store when the tab already has an answer
 *    for it, which is what makes the round trip through the pull request page
 *    instant. The stored copy is a head start and not an answer: the read below
 *    replaces it.
 * 3. The page then reads the diff route and the pull request route. The diff is the
 *    page; the pull request is read for its review threads, which is what puts the
 *    marks on the line numbers. A slow answer from an older read is dropped, so two
 *    answers cannot cross.
 *
 * Nothing is written to GitHub unless a reader presses `Submit review`: the page
 * collects the line comments in this tab and sends them in one request, which is what
 * a review is. A page that is only being read sends no write at all.
 */
import { mountAt, mountPage } from "../mount.ts";
import { Bar, Banner, View } from "../github-pr/diff-page.tsx";
import { drawStoredDiff, drawStoredThreads, loadDiff, loadThreads, startPending } from "../github-pr/diff-state.ts";

// The collection of comments this tab already holds for this pull request, which is
// what draws the comments a reader wrote before the page was reloaded.
startPending();
// The diff and the threads the tab already had, drawn before any request.
drawStoredDiff();
drawStoredThreads();

// The bar and the strip are taken over in place, so the elements the shell wrote keep
// their ids and the stylesheet's rules keep pointing at them. `#view` is a region
// rather than an element of its own, so the page is drawn inside it.
const bar = document.querySelector("#topbar");
if (bar === null) throw new Error("the diff page has no element matching #topbar");
mountAt(bar, <Bar />);
const strip = document.querySelector("#error-banner");
if (strip === null) throw new Error("the diff page has no element matching #error-banner");
mountAt(strip, <Banner />);
mountPage("#view", View);

// The threads are read alongside the diff and not before it: the code is what the
// page is for, and the marks are added when they arrive.
void loadThreads();
void loadDiff();
