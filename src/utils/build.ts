import { config, version } from "../../package.json";

/**
 * Identifies the running build. Two builds can carry the same version (a dev
 * build, or a release that was re-tagged), so the build time tells them apart.
 */
export const BUILD = {
  name: config.addonName,
  version,
  // The test bundle is built without our esbuild `define`.
  buildTime: typeof __buildTime__ === "string" ? __buildTime__ : "",
};
