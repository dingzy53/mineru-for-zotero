import { config } from "../../package.json";
import { FluentMessageId } from "../../typings/i10n";
import { TaskRecord } from "./taskStore";
import { ParseMode, ParseSource } from "../utils/prefs";

export const PROGRESS_WINDOW_ICON_URI = `chrome://${config.addonRef}/content/icons/favicon.png`;
export const PROGRESS_WINDOW_LABEL_LINE_HEIGHT_PX = 18;
export const PROGRESS_WINDOW_DETAIL_LEFT_OFFSET_PX = 22;
export const ELEMENT_NODE_TYPE = 1;
export const PROGRESS_WINDOW_PRESENTATION_RETRY_DELAYS_MS = [
  0, 50, 150, 300, 600,
];
export type ProgressWindowText = { text: string };
export type ProgressWindowLineOption = ProgressWindowText & {
  progress: number;
  icon: string;
};
export function normalizeProgressWindowText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
export function createProgressWindowLineOptions(
  lines: ProgressWindowText[],
): ProgressWindowLineOption[] {
  return [
    {
      text: lines[0]?.text ?? "",
      icon: PROGRESS_WINDOW_ICON_URI,
      progress: 100,
    },
  ];
}
export function createProgressWindowDisplayText(
  lines: ProgressWindowText[],
): string {
  return lines.map((line) => line.text).join("\n");
}
export function createProgressWindowDetailLines(
  lines: ProgressWindowText[],
): string[] {
  return lines.slice(1).map((line) => line.text);
}
export function getProgressWindowItemParent(
  image: HTMLElement | undefined,
): Element | null {
  const parent = image?.parentElement ?? image?.parentNode;
  return parent?.nodeType === ELEMENT_NODE_TYPE ? (parent as Element) : null;
}
export function applyProgressWindowItemIcon(
  progressWindow: unknown,
  iconURI: string,
): boolean {
  const lines = (
    progressWindow as unknown as {
      lines?: Array<{ _image?: HTMLElement }>;
    }
  ).lines;
  const image = lines?.[0]?._image;
  if (!image) {
    return false;
  }

  image.dataset.itemType = iconURI;
  image.style.backgroundImage = `url(${iconURI})`;
  image.style.backgroundRepeat = "no-repeat";
  image.style.backgroundPosition = "center center";
  image.style.backgroundSize = "16px 16px";
  return true;
}
export function applyProgressWindowDescriptionLineLayout(
  progressWindow: unknown,
  detailLines: string[],
): boolean {
  if (detailLines.length === 0) {
    return true;
  }

  const lines = (
    progressWindow as unknown as {
      lines?: Array<{ _hbox?: Element; _image?: HTMLElement }>;
    }
  ).lines;
  const mainLine = lines?.[0];
  const mainRow =
    mainLine?._hbox ?? getProgressWindowItemParent(mainLine?._image);
  const container = mainRow?.parentNode;
  if (!mainRow || !container) {
    return false;
  }

  let cursor = mainRow.nextSibling;
  for (const detailLine of detailLines) {
    const detailRow = findNextProgressWindowDetailRow(cursor, detailLine);
    if (!detailRow) {
      return false;
    }
    styleProgressWindowDetailRow(detailRow);
    cursor = detailRow.nextSibling;
  }
  return true;
}
export function scheduleProgressWindowPresentation(
  progressWindow: unknown,
  detailLines: string[],
): void {
  const retryDelays = [...PROGRESS_WINDOW_PRESENTATION_RETRY_DELAYS_MS];
  const apply = () => {
    const iconApplied = applyProgressWindowItemIcon(
      progressWindow,
      PROGRESS_WINDOW_ICON_URI,
    );
    const detailApplied = applyProgressWindowDescriptionLineLayout(
      progressWindow,
      detailLines,
    );
    if (iconApplied && detailApplied) {
      return;
    }
    const nextDelay = retryDelays.shift();
    if (typeof nextDelay === "number") {
      setTimeout(apply, nextDelay);
    }
  };
  apply();
}
export function findNextProgressWindowDetailRow(
  start: Node | null,
  text: string,
): HTMLElement | null {
  let cursor = start;
  while (cursor) {
    if (
      cursor.nodeType === ELEMENT_NODE_TYPE &&
      normalizeProgressWindowText(cursor.textContent ?? "") === text
    ) {
      return cursor as HTMLElement;
    }
    cursor = cursor.nextSibling;
  }
  return null;
}
export function styleProgressWindowDetailRow(row: HTMLElement): void {
  row.setAttribute("data-mineru-progress-detail-row", "true");
  row.style.marginLeft = `${PROGRESS_WINDOW_DETAIL_LEFT_OFFSET_PX}px`;
  row.style.minHeight = `${PROGRESS_WINDOW_LABEL_LINE_HEIGHT_PX}px`;
  row.style.height = "auto";
  row.style.overflow = "visible";

  const description = row.querySelector("description");
  if (description) {
    const descriptionStyle = (description as HTMLElement).style;
    descriptionStyle.lineHeight = `${PROGRESS_WINDOW_LABEL_LINE_HEIGHT_PX}px`;
    descriptionStyle.minHeight = `${PROGRESS_WINDOW_LABEL_LINE_HEIGHT_PX}px`;
    descriptionStyle.margin = "0";
    descriptionStyle.padding = "0";
  }
}
export function createProgressWindowTexts(
  id: FluentMessageId,
  args: Record<string, string> | undefined,
  resolveMessage: (
    id: FluentMessageId,
    args?: Record<string, string>,
  ) => string,
): ProgressWindowText[] {
  const mainText = normalizeProgressWindowText(resolveMessage(id, args));
  const detailText = createParseTaskDetailText(id, args, resolveMessage);
  return detailText
    ? [{ text: mainText }, { text: detailText }]
    : [{ text: mainText }];
}
export function createParseTaskDetailText(
  id: FluentMessageId,
  args: Record<string, string> | undefined,
  resolveMessage: (
    id: FluentMessageId,
    args?: Record<string, string>,
  ) => string,
): string | null {
  if (!isParseTaskNotice(id) || !args) {
    return null;
  }

  const detailID = getParseTaskDetailID(id);
  return normalizeProgressWindowText(
    resolveMessage(detailID, {
      ...args,
      modeLabel: resolveParseNoticeModeLabel(args.mode, resolveMessage),
      sourceLabel: resolveParseNoticeSourceLabel(args.source, resolveMessage),
    }),
  );
}
export function getParseTaskDetailID(id: FluentMessageId): FluentMessageId {
  if (id === "parse-task-submitted-total") {
    return "parse-task-detail-total";
  }
  if (id === "parse-task-finished-progress") {
    return "parse-task-detail-progress";
  }
  return "parse-task-detail";
}
export function isParseTaskNotice(id: FluentMessageId): boolean {
  return (
    id === "parse-task-finished" ||
    id === "parse-task-finished-progress" ||
    id === "parse-task-submitted" ||
    id === "parse-task-submitted-total"
  );
}
export function resolveParseNoticeModeLabel(
  mode: string | undefined,
  resolveMessage: (
    id: FluentMessageId,
    args?: Record<string, string>,
  ) => string,
): string {
  return mode === "lite"
    ? resolveMessage("parse-notice-mode-lite")
    : resolveMessage("parse-notice-mode-precise");
}
export function resolveParseNoticeSourceLabel(
  source: string | undefined,
  resolveMessage: (
    id: FluentMessageId,
    args?: Record<string, string>,
  ) => string,
): string {
  return source === "local"
    ? resolveMessage("parse-notice-source-local")
    : resolveMessage("parse-notice-source-online");
}
