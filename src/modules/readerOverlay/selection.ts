import { safeReaderOverlayCleanup } from "./diagnostics";
import type {
  ReaderOverlaySelectionOptions,
  ReaderOverlayState,
} from "./types";
import { getReaderOverlayStateForReader } from "./state";

/** Clears box selections for the current reader and synchronizes all rendered roots. */
export function clearReaderOverlaySelectionForReader(
  reader: _ZoteroTypes.ReaderInstance,
): ReaderOverlayState | null {
  const state = getReaderOverlayStateForReader(reader);
  if (!state) {
    return null;
  }
  state.selectedRawIndexes.clear();
  state.selectionAnchorRawIndex = null;
  state.hoverRawIndex = null;
  syncSelectedBoxClasses(state);
  return state;
}

/** Synchronizes selectedRawIndexes in state to classes on all rendered boxes. */
export function syncSelectedBoxClasses(state: ReaderOverlayState): void {
  for (const root of state.rootsByWindow.values()) {
    safeReaderOverlayCleanup(() => {
      for (const element of getBoxElements(root)) {
        const rawIndex = Number(element.dataset.rawIndex);
        setBoxSelectedClass(
          element,
          Number.isFinite(rawIndex) && state.selectedRawIndexes.has(rawIndex),
        );
      }
    });
  }
}

/** Toggles the selected class on a single box only. */
export function setBoxSelectedClass(
  element: HTMLElement,
  selected: boolean,
): void {
  setElementClass(element, "mineru-copy-box-selected", selected);
}

/** Toggles whether the overlay is in a modifier-key interactive state. */
export function setOverlayModifierActive(
  element: HTMLElement,
  active: boolean,
): void {
  setElementClass(element, "mineru-copy-overlay-modifier-active", active);
}

/** Updates the hover-hit box while keeping hover classes cleared on all other boxes. */
export function setHoveredBox(
  root: HTMLElement,
  hoveredBox: HTMLElement | null,
): void {
  for (const element of getBoxElements(root)) {
    setElementClass(element, "mineru-copy-box-hovered", element === hoveredBox);
  }
}

/** Finds the topmost interactive overlay box according to coordinates. */
export function findBoxAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  options: {
    prioritizeActiveActions?: boolean;
    selectPanelActive?: boolean;
    formulaMenuActive?: boolean;
  } = {},
): HTMLElement | null {
  const boxes = getBoxElements(root);
  const openSelectPanelBox = findOpenSelectPanelBoxAtPoint(
    boxes,
    clientX,
    clientY,
  );
  if (openSelectPanelBox.found) {
    return openSelectPanelBox.box;
  }
  if (options.selectPanelActive) {
    return null;
  }

  const openFormulaMenuBox = findOpenFormulaMenuBoxAtPoint(
    boxes,
    clientX,
    clientY,
  );
  if (openFormulaMenuBox.found) {
    return openFormulaMenuBox.box;
  }
  if (options.formulaMenuActive) {
    return null;
  }

  if (options.prioritizeActiveActions ?? true) {
    const activeBoxes = boxes.filter((box) =>
      hasClassName(box, "mineru-copy-box-actions-active"),
    );
    const activeBox =
      findLastBoxWithVisibleActions(activeBoxes) ??
      findBoxInActionsHoverArea(activeBoxes, clientX, clientY);
    if (activeBox) {
      return activeBox;
    }
  }

  const hoveredBox = boxes.find((box) =>
    box.className.split(/\s+/).includes("mineru-copy-box-hovered"),
  );
  const actionHoveredBox = findBoxInActionsHoverArea(
    hoveredBox ? [hoveredBox] : [],
    clientX,
    clientY,
  );
  if (actionHoveredBox) {
    return actionHoveredBox;
  }

  const visibleActionsBox = findBoxInVisibleActionsHoverArea(
    boxes,
    clientX,
    clientY,
  );
  if (visibleActionsBox) {
    return visibleActionsBox;
  }

  const normalHitTestBoxes = getNormalHitTestBoxes(
    root,
    boxes,
    clientX,
    clientY,
  );
  for (let index = normalHitTestBoxes.length - 1; index >= 0; index -= 1) {
    const box = normalHitTestBoxes[index];
    const rect = box.getBoundingClientRect?.();
    if (rect && isPointInRect(clientX, clientY, rect)) {
      return box;
    }
  }
  return null;
}

function findLastBoxWithVisibleActions(
  boxes: HTMLElement[],
): HTMLElement | null {
  for (let index = boxes.length - 1; index >= 0; index -= 1) {
    const box = boxes[index];
    const actions = getBoxActionsElement(box);
    if (actions && isElementVisiblyRected(actions)) {
      return box;
    }
  }
  return null;
}

function findBoxInVisibleActionsHoverArea(
  boxes: HTMLElement[],
  clientX: number,
  clientY: number,
): HTMLElement | null {
  for (let index = boxes.length - 1; index >= 0; index -= 1) {
    const box = boxes[index];
    const actions = getBoxActionsElement(box);
    if (!actions || !isElementVisiblyRected(actions)) {
      continue;
    }
    const rect = box.getBoundingClientRect?.();
    if (rect && isPointInBoxActionsHoverArea(box, rect, clientX, clientY)) {
      return box;
    }
  }
  return null;
}

function getNormalHitTestBoxes(
  root: HTMLElement,
  boxes: HTMLElement[],
  clientX: number,
  clientY: number,
): HTMLElement[] {
  const layers = getPageLayerElements(root);
  if (layers.length === 0) {
    return boxes;
  }

  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer.hidden) {
      continue;
    }
    const rect = layer.getBoundingClientRect?.();
    if (rect && isPointInRect(clientX, clientY, rect)) {
      return getBoxElements(layer);
    }
  }
  return boxes;
}

function getPageLayerElements(root: HTMLElement): HTMLElement[] {
  if (typeof root.querySelectorAll !== "function") {
    return [];
  }
  return Array.from(
    root.querySelectorAll(".mineru-copy-page-layer"),
  ) as HTMLElement[];
}

function findOpenSelectPanelBoxAtPoint(
  boxes: HTMLElement[],
  clientX: number,
  clientY: number,
): { found: true; box: HTMLElement | null } | { found: false } {
  const openPanelBoxes = boxes.filter((box) =>
    hasClassName(getBoxActionsElement(box), "mineru-copy-select-panel-open"),
  );
  if (openPanelBoxes.length === 0) {
    return { found: false };
  }

  return {
    found: true,
    box: findBoxInActionsHoverArea(openPanelBoxes, clientX, clientY),
  };
}

function findOpenFormulaMenuBoxAtPoint(
  boxes: HTMLElement[],
  clientX: number,
  clientY: number,
): { found: true; box: HTMLElement | null } | { found: false } {
  const openMenuBoxes = boxes.filter((box) =>
    hasClassName(getBoxActionsElement(box), "mineru-copy-formula-menu-open"),
  );
  if (openMenuBoxes.length === 0) {
    return { found: false };
  }

  return {
    found: true,
    box: findBoxInActionsHoverArea(openMenuBoxes, clientX, clientY),
  };
}

function findBoxInActionsHoverArea(
  boxes: HTMLElement[],
  clientX: number,
  clientY: number,
): HTMLElement | null {
  for (let index = boxes.length - 1; index >= 0; index -= 1) {
    const box = boxes[index];
    const rect = box.getBoundingClientRect?.();
    if (rect && isPointInBoxActionsHoverArea(box, rect, clientX, clientY)) {
      return box;
    }
  }
  return null;
}

/** Checks className / classList compatibility across real DOM and test stubs. */
function hasClassName(element: HTMLElement | null, className: string): boolean {
  if (element?.classList) {
    return element.classList.contains(className);
  }
  return String(element?.className ?? "")
    .split(/\s+/)
    .includes(className);
}

/** Maintains hit testing for the hover area beneath box actions, preventing slight downward mouse movements from losing hover. */
export function isPointInBoxActionsHoverArea(
  box: HTMLElement,
  rect: DOMRect,
  clientX: number,
  clientY: number,
): boolean {
  const actions = getBoxActionsElement(box);
  const actionHoverRects = getBoxActionsHoverRects(actions);
  if (actionHoverRects.length === 0) {
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.bottom &&
      clientY <= rect.bottom + 36
    );
  }

  if (
    actionHoverRects.some((actionRect) =>
      isPointInRect(clientX, clientY, actionRect),
    )
  ) {
    return true;
  }

  const actionsRect = actionHoverRects[0];
  return (
    clientX >= actionsRect.left &&
    clientX <= actionsRect.right &&
    clientY >= Math.min(rect.bottom, actionsRect.top) &&
    clientY <= Math.max(rect.bottom, actionsRect.top)
  );
}

/** Returns rectangles for the actions body and floating submenus extending beyond the box to sustain hover hits. */
export function getBoxActionsHoverRects(
  actions: HTMLElement | null,
): DOMRect[] {
  if (!actions?.getBoundingClientRect) {
    return [];
  }
  const rects = [actions.getBoundingClientRect()];
  const querySelectorAll = actions.querySelectorAll?.bind(actions);
  if (!querySelectorAll) {
    return rects;
  }
  for (const selector of [
    ".mineru-copy-formula-menu",
    ".mineru-copy-select-panel",
  ]) {
    for (const element of Array.from(
      querySelectorAll(selector),
    ) as HTMLElement[]) {
      const rect = element.getBoundingClientRect?.();
      if (rect) {
        rects.push(rect);
      }
    }
  }
  return rects;
}

/** Determines whether given coordinates fall within the specified rectangle. */
export function isPointInRect(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): boolean {
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function isElementVisiblyRected(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect?.();
  return Boolean(
    rect &&
    (rect.width > 0 ||
      rect.height > 0 ||
      rect.right > rect.left ||
      rect.bottom > rect.top),
  );
}

/** Reads the action container on a box, compatible with real DOM and test stubs. */
export function getBoxActionsElement(box: HTMLElement): HTMLElement | null {
  const querySelector = box.querySelector?.bind(box);
  if (querySelector) {
    return querySelector(".mineru-copy-box-actions") as HTMLElement | null;
  }

  const querySelectorAll = box.querySelectorAll?.bind(box);
  const firstAction = querySelectorAll?.(".mineru-copy-box-actions")[0] as
    | HTMLElement
    | undefined;
  return firstAction ?? null;
}

/** Reads all overlay box elements under root. */
export function getBoxElements(root: HTMLElement): HTMLElement[] {
  if (typeof root.querySelectorAll !== "function") {
    return [];
  }
  return Array.from(root.querySelectorAll(".mineru-copy-box")) as HTMLElement[];
}

/** Updates the selection set based on the clicked box element and refreshes corresponding styles. */
export function applyReaderOverlayBoxSelectionFromElement(
  element: HTMLElement,
  rangeSelection: boolean,
  selectionOptions: ReaderOverlaySelectionOptions | undefined,
): void {
  const selectedRawIndexes = selectionOptions?.selectedRawIndexes;
  if (!selectedRawIndexes) {
    return;
  }

  const rawIndex = Number(element.dataset.rawIndex);
  if (!Number.isFinite(rawIndex)) {
    return;
  }

  if (rangeSelection) {
    selectBoxRange(rawIndex, selectionOptions);
  } else if (selectedRawIndexes.has(rawIndex)) {
    selectedRawIndexes.delete(rawIndex);
  } else {
    selectedRawIndexes.add(rawIndex);
  }
  selectionOptions.setSelectionAnchorRawIndex?.(rawIndex);
  setBoxSelectedClass(element, selectedRawIndexes.has(rawIndex));
  selectionOptions.onSelectionChange?.();
}

/** Determines whether an object supports add/removeEventListener to be used as an EventTarget. */
export function isEventTarget(value: unknown): value is EventTarget {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as EventTarget).addEventListener === "function" &&
    typeof (value as EventTarget).removeEventListener === "function"
  );
}

/** Safely toggles class names, compatible with real DOM and test stub objects. */
export function setElementClass(
  element: HTMLElement,
  className: string,
  enabled: boolean,
): void {
  if (element.classList) {
    if (element.classList.contains(className) === enabled) {
      return;
    }
    element.classList.toggle(className, enabled);
    return;
  }

  const currentClassName =
    typeof element.className === "string" ? element.className : "";
  const classes = new Set(currentClassName.split(/\s+/).filter(Boolean));
  if (classes.has(className) === enabled) {
    return;
  }
  if (enabled) {
    classes.add(className);
  } else {
    classes.delete(className);
  }
  element.className = [...classes].join(" ");
}

/** Fills out Shift multi-selection across the selectableRawIndexes range. */
export function selectBoxRange(
  rawIndex: number,
  selectionOptions: ReaderOverlaySelectionOptions,
): void {
  const selectedRawIndexes = selectionOptions.selectedRawIndexes;
  if (!selectedRawIndexes) {
    return;
  }

  const anchorRawIndex =
    selectionOptions.getSelectionAnchorRawIndex?.() ?? null;
  if (anchorRawIndex === null) {
    selectedRawIndexes.add(rawIndex);
    return;
  }

  const rangeRawIndexes = getRawIndexRange(
    getRangeSelectableRawIndexes(selectionOptions, anchorRawIndex, rawIndex),
    anchorRawIndex,
    rawIndex,
  );
  for (const rangeRawIndex of rangeRawIndexes) {
    selectedRawIndexes.add(rangeRawIndex);
  }
}

/** Prefers filtered range candidates; falls back to the full selectable set when endpoints are outside candidates. */
function getRangeSelectableRawIndexes(
  selectionOptions: ReaderOverlaySelectionOptions,
  anchorRawIndex: number,
  rawIndex: number,
): number[] {
  const rangeSelectableRawIndexes =
    selectionOptions.rangeSelectableRawIndexes ?? [];
  if (
    rangeSelectableRawIndexes.includes(anchorRawIndex) &&
    rangeSelectableRawIndexes.includes(rawIndex)
  ) {
    return rangeSelectableRawIndexes;
  }
  return selectionOptions.selectableRawIndexes ?? [];
}

/** Computes the closed interval between two rawIndex values within selectableRawIndexes. */
export function getRawIndexRange(
  selectableRawIndexes: number[],
  startRawIndex: number,
  endRawIndex: number,
): number[] {
  const startPosition = selectableRawIndexes.indexOf(startRawIndex);
  const endPosition = selectableRawIndexes.indexOf(endRawIndex);
  if (startPosition >= 0 && endPosition >= 0) {
    const start = Math.min(startPosition, endPosition);
    const end = Math.max(startPosition, endPosition);
    return selectableRawIndexes.slice(start, end + 1);
  }

  const start = Math.min(startRawIndex, endRawIndex);
  const end = Math.max(startRawIndex, endRawIndex);
  return selectableRawIndexes.filter(
    (candidate) => candidate >= start && candidate <= end,
  );
}
