/**
 * Notes: the daemon's five most recent diagnostics.
 *
 * Each note is the time it happened and the server's own sentence, newest first.
 * The panel hides itself while there are none: a note records a failure that left
 * no other trace (a config reload that failed, a review that could not be
 * delivered, a forwarded prefix that disagrees with the mount), so an empty panel
 * would be a promise with nothing behind it.
 */
import { noteAge, recentNotes } from "../../state/notes.ts";

/** The panel the shell carries as `#notes-panel`. */
export function NotesPanel() {
  const list = recentNotes();
  return (
    <section id="notes-panel" class={list.length === 0 ? "panel hidden" : "panel"}>
      <h2>Notes</h2>
      <div id="notes" class="notes">
        {list.map((note) => (
          <div class="note" key={`${note.at}:${note.text}`}>
            <div class="note-meta">{noteAge(note)}</div>
            <div class="note-body">{note.text}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
