/**
 * The list helper the "an update never resets what the user did not touch" rules
 * rest on.
 *
 * A list drawn from a server answer is matched to the list drawn before it by
 * the id the server gave each item. An item whose fields did not change keeps
 * the object it had, so the component that draws it sees the same value and
 * leaves the element under it alone. Only a changed item becomes a new object.
 *
 * The order is the incoming one. When nothing changed at all — same ids, same
 * order, same fields — the current array is returned itself, so a signal that
 * holds it does not notify its readers and nothing is drawn again.
 */

/** Whether two values are the same field by field, one level deep. */
function shallowSame(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Match `incoming` to `current` by key, and keep every unchanged item's object.
 *
 * `same` decides whether a pair of items with the same key counts as unchanged;
 * the default compares the fields one level deep, because an item that came back
 * from the server as a fresh object with the same fields is unchanged to a
 * reader. A pair whose key is new, or a key the previous list did not hold, is
 * always taken from `incoming`.
 *
 * A key that appears twice in `incoming` is matched to the same previous item
 * twice; the caller is expected to send ids that are unique, as the server does.
 */
export function reconcileById<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (item: T) => string,
  same: (previous: T, next: T) => boolean = shallowSame,
): readonly T[] {
  const previous = new Map<string, T>();
  for (const item of current) {
    const id = key(item);
    if (!previous.has(id)) previous.set(id, item);
  }

  let unchanged = current.length === incoming.length;
  const next = incoming.map((item, index) => {
    const kept = previous.get(key(item));
    if (kept === undefined) {
      unchanged = false;
      return item;
    }
    if (same(kept, item)) {
      if (current[index] !== kept) unchanged = false;
      return kept;
    }
    unchanged = false;
    return item;
  });

  return unchanged ? current : next;
}
