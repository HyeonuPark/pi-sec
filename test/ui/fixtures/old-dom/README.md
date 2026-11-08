# The hand-written pages' DOM, kept after the switch

These files are the element trees that the hand-written page scripts drew. The
switch commit deleted those scripts, so the two structure tests that used to run
them now compare the new page against a tree frozen here.

| File | Produced by | Read by |
|---|---|---|
| `usage-two-cards.html` | `test/ui/usage-page.test.ts` "draws the same element tree, ids and classes the hand-written page drew" | the same test |
| `usage-empty.html` | `test/ui/usage-page.test.ts` "draws the same tree for an empty answer and for a held value" (empty answer) | the same test |
| `usage-held.html` | the same test (a card whose value was kept) | the same test |
| `chats-two-lists.html` | `test/ui/chats-page.test.ts` "draws the same elements, classes, attributes and order as the hand-written page" | the same test |
| `chats-empty.html` | `test/ui/chats-page.test.ts` "draws the same markup for empty lists" | the same test |

## Where they came from

- Source: the page scripts that drew the old pages. They no longer exist, and the
  trees here were frozen from them before they were deleted.
- The answer each page received is the one its test passes: the usage page got
  `BOTH`, an empty card list, and the Anthropic card with `hold: { kind: "kept" }`;
  the chats page got one open chat, one untitled open chat, one open test chat and
  one archived chat, and then an empty list.
- A one-off test file loaded each page in jsdom with the same fake server its test
  uses, ran `base.js` and the page script, waited for the page to settle, and wrote
  what the page had drawn. The usage files hold the whole document, because that
  test compares the body element by element; the chats files hold the snapshot's
  `innerHTML` alone, because that test compares that string. The one-off file was
  removed with the scripts it loaded.

The old page scripts are gone, so you cannot regenerate these files. If you replace
one of them by hand, write the tree the new page must keep. A tree that no longer matches the new page is a change
to the new page's markup, and it fails the test that reads the file.

## Edit after the switch

The three usage files carry one added line, the `stats-link` anchor in the header
(`/usage/stats`), which the model speed page change added to `usage.html`. Nothing
else in them was touched.
