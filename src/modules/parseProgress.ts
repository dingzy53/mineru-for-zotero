import { FluentMessageId } from "../../typings/i10n";

export type ProgressWindowText = { text: string };

/** Collapse Fluent text into a single line to prevent unwanted newlines in progress/notice texts. */
function normalizeProgressWindowText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resolveParseNoticeModeLabel(
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

function resolveParseNoticeSourceLabel(
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

function getParseTaskDetailID(id: FluentMessageId): FluentMessageId {
  if (id === "parse-task-submitted-total") {
    return "parse-task-detail-total";
  }
  if (id === "parse-task-finished-progress") {
    return "parse-task-detail-progress";
  }
  return "parse-task-detail";
}

function isParseTaskNotice(id: FluentMessageId): boolean {
  return (
    id === "parse-task-finished" ||
    id === "parse-task-finished-progress" ||
    id === "parse-task-submitted" ||
    id === "parse-task-submitted-total"
  );
}

function createParseTaskDetailText(
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

/** Parse a notification into a primary line and optional detail line (for plain text contexts like alerts/logs). */
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
