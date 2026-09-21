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

/** 兼容真实 DOM 与测试桩的 className / classList 判断。 */
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
 * 判断事件目标是否落在指定选择器/类名的元素内。
 *
 * 优先使用 `closest`，并用 `hasClassName` 向上遍历作为测试桩与跨窗口
 * 死对象场景的回退实现。
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
