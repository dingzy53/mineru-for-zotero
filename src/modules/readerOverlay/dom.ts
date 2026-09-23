/**
 * DOM helpers shared across the reader overlay modules.
 *
 * The overlay runs inside real reader windows but is also exercised by
 * lightweight DOM stubs in tests, so class checks and ancestor walks tolerate
 * both `classList` and the legacy `className` string.
 */

export interface ClassNameCarrier {
  className?: unknown;
  classList?: { contains: (className: string) => boolean };
}

export interface ClassTargetCarrier extends ClassNameCarrier {
  closest?: (selector: string) => Element | null;
  parentElement?: unknown;
}

/** Checks className / classList compatibility across real DOM and test stubs. */
export function hasClassName(
  element: ClassNameCarrier,
  className: string,
): boolean {
  if (element.classList?.contains(className)) {
    return true;
  }
  return (
    typeof element.className === "string" &&
    element.className.split(/\s+/).includes(className)
  );
}

/**
 * Determines whether the event target falls within an element matching a given selector/class name.
 *
 * Prefers `closest`, falling back to an upward traversal using `hasClassName`
 * for test stubs and cross-window dead object scenarios.
 */
export function isInsideClassTarget(
  target: EventTarget | null,
  selector: string,
  classNames: readonly string[],
): boolean {
  const closest = (target as ClassTargetCarrier | null)?.closest;
  if (typeof closest === "function") {
    try {
      if (closest.call(target, selector)) {
        return true;
      }
    } catch {
      // Reader teardown can leave cross-window dead objects behind.
    }
  }

  let element = target as ClassTargetCarrier | null;
  while (element) {
    if (
      classNames.some((name) => hasClassName(element as ClassNameCarrier, name))
    ) {
      return true;
    }
    element = element.parentElement as ClassTargetCarrier | null;
  }
  return false;
}
