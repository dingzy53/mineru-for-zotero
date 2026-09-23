/** Converts an unknown thrown value into a readable diagnostic message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Emits reader toolbar diagnostic information to Zotero and browser consoles on a best-effort basis. */
export function emitReaderToolbarDiagnostic(
  reader: _ZoteroTypes.ReaderInstance | undefined,
  message: string,
  payload: Record<string, unknown>,
): void {
  const text = `[MinerU for Zotero] ${message} ${JSON.stringify(payload)}`;

  try {
    ztoolkit.log(message, payload);
  } catch {
    // Keep diagnostics best-effort; log failures must not fail menu commands.
  }

  try {
    Zotero.debug(text);
  } catch {
    // Zotero.debug may not be available in isolated test/runtime environments.
  }

  const consoles = new Set<Console>();
  if (typeof console !== "undefined") {
    consoles.add(console);
  }
  const readerConsole = reader?._iframeWindow?.console;
  if (readerConsole) {
    consoles.add(readerConsole);
  }

  try {
    const mainWindowConsole = Zotero.getMainWindow?.().console;
    if (mainWindowConsole) {
      consoles.add(mainWindowConsole);
    }
  } catch {
    // The main window is not always available during cleanup phases.
  }

  for (const targetConsole of consoles) {
    targetConsole.info(text);
  }
}
