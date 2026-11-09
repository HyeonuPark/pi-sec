/**
 * A small memo for function components.
 *
 * A component that is wrapped here is not drawn again when its parent draws and
 * the properties compare equal. It is built on `shouldComponentUpdate` of a class
 * and not on `preact/compat`, because compat installs global hooks that change how
 * events of text inputs are handled, and no page here uses it.
 *
 * The wrapped function still draws as its own component, so a signal it reads
 * redraws it alone: the wrapper only decides what a parent's draw does.
 */
import { Component, h, type ComponentChildren, type FunctionComponent } from "preact";

/** True when both objects have the same keys and every value is identical. */
export function shallowEqual(left: object, right: object): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/** Wrap `render` so a parent's draw with equal properties does not draw it. */
export function memo<P extends object>(
  render: FunctionComponent<P>,
  equal: (previous: P, next: P) => boolean = shallowEqual,
): FunctionComponent<P> {
  class Memo extends Component<P> {
    shouldComponentUpdate(next: P): boolean {
      return !equal(this.props, next);
    }
    render(): ComponentChildren {
      return h(render as FunctionComponent<object>, this.props as object);
    }
  }
  (Memo as unknown as { displayName: string }).displayName = `Memo(${render.name})`;
  return Memo as unknown as FunctionComponent<P>;
}
