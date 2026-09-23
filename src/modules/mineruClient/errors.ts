/**
 * Error representing a failure during a MinerU HTTP request stage.
 */
export class MinerURequestError extends Error {
  /**
   * Construct a request error with stage, HTTP status code, and error details.
   */
  constructor(
    public readonly stage: string,
    public readonly status: number,
    detail?: string,
  ) {
    super(
      detail
        ? `MinerU ${stage} request failed: ${detail}`
        : `MinerU ${stage} request failed with status ${status}`,
    );
    this.name = "MinerURequestError";
  }
}

/**
 * Error representing a failure to read a local PDF file.
 */
export class MinerUFileAccessError extends Error {
  /**
   * Construct a file access error with file path and underlying failure details.
   */
  constructor(
    public readonly filePath: string,
    detail?: string,
  ) {
    super(
      detail
        ? `Cannot read PDF file ${filePath}: ${detail}`
        : `Cannot read PDF file ${filePath}`,
    );
    this.name = "MinerUFileAccessError";
  }
}

/**
 * Error representing a failure during MinerU task submission, polling, download, or parsing.
 */
export class MinerUTaskError extends Error {
  /**
   * Construct a MinerU task error with an optional cause.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "MinerUTaskError";
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
