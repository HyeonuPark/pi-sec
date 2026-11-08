/**
 * The daemon's recent diagnostics, as the sidebar's Notes panel shows them.
 *
 * The status route (`GET /api/admin/status`) carries `notes`: newest last, each
 * with the instant it happened. The panel shows the five most recent, newest
 * first, and hides itself while there are none: a note is a trace of a failure
 * that left none anywhere else (a config reload that failed, a review that could
 * not be delivered, a forwarded prefix that disagrees with the mount), so an
 * empty panel would be a promise with nothing behind it.
 *
 * The rest of the status answer — the restart banner, the config error, the stale
 * sections — belongs to the header, which reads the same route. A page that
 * reads it once can hand the answer to {@link applyStatus} so there is one read
 * for both; a page that draws only this panel can call {@link refreshNotes}.
 */
import { signal } from "@preact/signals";
import { request } from "../api/request.ts";
import { relativeTime } from "./inbox.ts";

/** One diagnostic the daemon recorded. */
export interface AdminNote {
  readonly at: number;
  readonly text: string;
}

/** How many notes the panel shows. */
export const NOTES_LIMIT = 5;

/** The daemon's notes, oldest first, as the status route answered. */
export const notes = signal<readonly AdminNote[]>([]);

/** The five newest notes, newest first. */
export function recentNotes(): readonly AdminNote[] {
  return [...notes.value].reverse().slice(0, NOTES_LIMIT);
}

/** The note's own age text, as the panel writes it. */
export function noteAge(note: AdminNote): string {
  return relativeTime(note.at);
}

/** Whether a value is one note. Anything else is dropped rather than drawn. */
function isNote(value: unknown): value is AdminNote {
  if (typeof value !== "object" || value === null) return false;
  const note = value as { at?: unknown; text?: unknown };
  return typeof note.text === "string";
}

/** Take the notes out of a status answer, and nothing else. */
export function applyStatus(status: { readonly notes?: unknown } | undefined): void {
  const list = status?.notes;
  notes.value = Array.isArray(list) ? list.filter(isNote) : [];
}

/** Read the status route for its notes. A failed read keeps the last notes. */
export async function refreshNotes(): Promise<void> {
  try {
    applyStatus(await request<{ notes?: unknown }>("/api/admin/status"));
  } catch {
    /* ignore: the last notes stay on screen */
  }
}

/** Put this module back where a freshly loaded page starts. */
export function resetNotesState(): void {
  notes.value = [];
}
