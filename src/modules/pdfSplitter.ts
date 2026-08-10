import { toNativePath } from "./mineruClient/path";
import { getRuntimePlatform } from "./mineruClient/download";
import { PDFDocument } from "pdf-lib";

/**
 * Cached resolved pdftk absolute path to avoid repeated filesystem probes.
 */
let cachedPdftkPath: string | null = null;

/**
 * Reads the user-configured pdftk path preference, if set.
 */
function getUserPdftkPath(): string {
  try {
    const value = (globalThis as any).Zotero?.Prefs?.get(
      "extensions.zotero.mineruForZotero.pdftkPath",
      true,
    );
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Imports the Mozilla Subprocess module from available sources.
 */
async function getSubprocess(): Promise<any> {
  try {
    return (globalThis as any).ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    ).Subprocess;
  } catch {
    // ignore
  }
  try {
    return (globalThis as any).ChromeUtils.import(
      "resource://gre/modules/Subprocess.jsm",
    ).Subprocess;
  } catch {
    // ignore
  }
  throw new Error("Subprocess module not available in this environment");
}

/**
 * Checks whether a file exists at the given native path.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    if (typeof IOUtils !== "undefined") {
      return await IOUtils.exists(path);
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Returns platform-specific candidate absolute paths for the pdftk executable.
 */
function getPlatformPdftkPaths(): string[] {
  const platform = getRuntimePlatform();

  if (platform === "win") {
    return [
      // Chocolatey shim
      "C:\\ProgramData\\chocolatey\\bin\\pdftk.exe",
      // Standard PDFtk Server installer locations
      "C:\\Program Files\\PDFtk Server\\bin\\pdftk.exe",
      "C:\\Program Files (x86)\\PDFtk Server\\bin\\pdftk.exe",
      "C:\\Program Files\\PDFtk\\bin\\pdftk.exe",
      "C:\\Program Files (x86)\\PDFtk\\bin\\pdftk.exe",
      // Scoop
      "C:\\Users\\scoop\\shims\\pdftk.exe",
    ];
  }

  if (platform === "mac") {
    return [
      // Homebrew Apple Silicon
      "/opt/homebrew/bin/pdftk",
      // Homebrew Intel
      "/usr/local/bin/pdftk",
      // MacPorts
      "/opt/local/bin/pdftk",
      // System
      "/usr/bin/pdftk",
    ];
  }

  // Linux and unknown
  return [
    "/usr/bin/pdftk",
    "/usr/local/bin/pdftk",
    // Snap
    "/snap/bin/pdftk",
    // Linuxbrew
    "/home/linuxbrew/.linuxbrew/bin/pdftk",
  ];
}

/**
 * Builds an augmented PATH environment for the subprocess so that wrapper
 * scripts (e.g. pdftk-java calling `java`) can find their dependencies.
 */
function getAugmentedEnvironment(): Record<string, string> {
  const platform = getRuntimePlatform();

  // Extra directories to prepend to PATH for GUI-launched apps
  const extraPaths: string[] = [];

  if (platform === "mac") {
    extraPaths.push(
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/opt/local/bin",
      // Common Java locations on macOS
      "/opt/homebrew/opt/openjdk/bin",
      "/usr/local/opt/openjdk/bin",
      "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin",
      "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin",
    );
  } else if (platform === "linux") {
    extraPaths.push(
      "/usr/local/bin",
      "/snap/bin",
      "/home/linuxbrew/.linuxbrew/bin",
    );
  } else if (platform === "win") {
    extraPaths.push("C:\\ProgramData\\chocolatey\\bin");
  }

  if (extraPaths.length === 0) {
    return {};
  }

  // Read current PATH from the process environment
  let currentPath = "";
  try {
    const env = (globalThis as any).Services?.env;
    if (env?.get) {
      currentPath = env.get("PATH") || "";
    }
  } catch {
    // ignore
  }

  const separator = platform === "win" ? ";" : ":";
  const augmentedPath = [...extraPaths, currentPath]
    .filter(Boolean)
    .join(separator);

  return { PATH: augmentedPath };
}

/**
 * Resolves the pdftk executable to an absolute path that can be passed to
 * Subprocess.call. Checks user preference, then probes platform-specific
 * common installation directories.
 */
async function resolvePdftkPath(): Promise<string> {
  // Return cached path if still valid
  if (cachedPdftkPath) {
    if (await fileExists(cachedPdftkPath)) {
      return cachedPdftkPath;
    }
    cachedPdftkPath = null;
  }

  // 1. User-configured path takes highest priority
  const userPath = getUserPdftkPath();
  if (userPath) {
    const nativePath = toNativePath(userPath);
    if (await fileExists(nativePath)) {
      cachedPdftkPath = nativePath;
      return nativePath;
    }
    throw new Error(
      `User-configured pdftk path does not exist: ${userPath}. ` +
        `Please update the pdftk path in MinerU for Zotero preferences.`,
    );
  }

  // 2. Try Subprocess.pathSearch (searches process PATH)
  try {
    const Subprocess = await getSubprocess();
    if (Subprocess.pathSearch) {
      const resolved = await Subprocess.pathSearch("pdftk");
      if (resolved) {
        cachedPdftkPath = resolved;
        return resolved;
      }
    }
  } catch {
    // pathSearch may not exist or may throw; continue to manual probe
  }

  // 3. Probe platform-specific common paths
  const candidates = getPlatformPdftkPaths();
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      cachedPdftkPath = candidate;
      return candidate;
    }
  }

  const platform = getRuntimePlatform();
  const hint =
    platform === "win"
      ? "Install via: choco install pdftk-server"
      : platform === "mac"
        ? "Install via: brew install pdftk-java"
        : "Install via: sudo apt install pdftk-java";

  throw new Error(
    `pdftk executable not found. Searched: ${candidates.join(", ")}. ${hint}. ` +
      `Or set a custom path in MinerU for Zotero preferences.`,
  );
}

/**
 * Clears the cached pdftk path so the next call will re-resolve it.
 */
export function clearPdftkPathCache(): void {
  cachedPdftkPath = null;
}

/**
 * Reads all available string content from a Subprocess pipe.
 */
async function readAll(pipe: any): Promise<string> {
  let result = "";
  let chunk;
  while ((chunk = await pipe.readString())) {
    result += chunk;
  }
  return result;
}

/**
 * Executes a pdftk command with the given arguments. Resolves the pdftk
 * binary path automatically and passes an augmented PATH environment so
 * wrapper scripts (pdftk-java) can find Java.
 */
export async function runPdftkCommand(args: string[]): Promise<string> {
  const Subprocess = await getSubprocess();
  const pdftkPath = await resolvePdftkPath();
  const environment = getAugmentedEnvironment();

  const callOptions: any = {
    command: pdftkPath,
    arguments: args,
  };

  // Pass augmented environment if we have extra PATH entries
  if (environment.PATH) {
    callOptions.environmentAppend = true;
    callOptions.environment = environment;
  }

  const proc = await Subprocess.call(callOptions);
  const [stdout, stderr] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
  ]);
  const { exitCode } = await proc.wait();

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`pdftk failed (exit ${exitCode}): ${detail}`);
  }

  return stdout;
}

/**
 * Runs pdftk --version and returns detailed diagnostic information.
 */
export async function testPdftk(): Promise<{
  success: boolean;
  path: string;
  output: string;
  error?: string;
  platform: string;
  searchedPaths: string[];
}> {
  const platform = getRuntimePlatform();
  const searchedPaths = [getUserPdftkPath(), ...getPlatformPdftkPaths()].filter(
    Boolean,
  );

  try {
    const pdftkPath = await resolvePdftkPath();
    const output = await runPdftkCommand(["--version"]);
    return {
      success: true,
      path: pdftkPath,
      output: output.substring(0, 300),
      platform,
      searchedPaths,
    };
  } catch (e: any) {
    return {
      success: false,
      path: cachedPdftkPath || "(not found)",
      output: "",
      error: String(e.message || e),
      platform,
      searchedPaths,
    };
  }
}

export async function getPdfPageCount(filePath: string): Promise<number> {
  const nativePath = toNativePath(filePath);

  try {
    const uint8Array = await IOUtils.read(nativePath);
    const pdfDoc = await PDFDocument.load(uint8Array, {
      ignoreEncryption: true,
    });
    return pdfDoc.getPageCount();
  } catch (e) {
    ztoolkit.log("Failed to get pdf page count via pdf-lib, trying pdftk", e);
  }

  // Fallback to pdftk
  try {
    const output = await runPdftkCommand([nativePath, "dump_data"]);
    const match = output.match(/NumberOfPages:\s*(\d+)/);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  } catch (e) {
    ztoolkit.log("Failed to get pdf page count via pdftk", e);
  }

  return -1;
}

export async function splitPdf(
  filePath: string,
  targetPath: string,
  startPage: number, // 1-indexed
  endPage: number, // 1-indexed
): Promise<boolean> {
  const nativePath = toNativePath(filePath);
  const nativeTarget = toNativePath(targetPath);

  try {
    const uint8Array = await IOUtils.read(nativePath);

    const pdfDoc = await PDFDocument.load(uint8Array, {
      ignoreEncryption: true,
    });
    const newPdfDoc = await PDFDocument.create();

    const pageIndices = [];
    for (let i = startPage - 1; i < endPage; i++) {
      pageIndices.push(i);
    }

    const copiedPages = await newPdfDoc.copyPages(pdfDoc, pageIndices);
    for (const page of copiedPages) {
      newPdfDoc.addPage(page);
    }

    const pdfBytes = await newPdfDoc.save();
    await IOUtils.write(nativeTarget, pdfBytes);
    return true;
  } catch (e) {
    ztoolkit.log("Failed to split pdf via pdf-lib, trying pdftk", e);
  }

  // Fallback to pdftk
  try {
    await runPdftkCommand([
      nativePath,
      "cat",
      `${startPage}-${endPage}`,
      "output",
      nativeTarget,
    ]);
    return true;
  } catch (e) {
    ztoolkit.log("Failed to split pdf via pdftk", e);
  }

  return false;
}
