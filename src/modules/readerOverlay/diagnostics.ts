/** Logs overlay diagnostic information, ensuring diagnostics never interfere with reader interactions. */
export function logReaderOverlayDiagnostic(
  message: string,
  payload: Record<string, unknown>,
): void {
  try {
    ztoolkit.log(`MinerU reader overlay ${message}`, payload);
  } catch {
    // Diagnostics must not interfere with reader interactions.
  }

  try {
    Zotero.debug(
      `[MinerU for Zotero] reader overlay ${message} ${JSON.stringify(payload)}`,
    );
  } catch {
    // Zotero.debug may not be available during testing or teardown.
  }
}

/** Swallows dead object exceptions during cleanup to avoid interrupting split view teardown. */
export function safeReaderOverlayCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    if (!isDeadObjectError(error)) {
      throw error;
    }
  }
}

/** Determines whether the current exception originates from a Firefox/Zotero dead object access. */
export function isDeadObjectError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    String(error.message).includes("can't access dead object")
  );
}
