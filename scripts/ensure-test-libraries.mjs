/**
 * 为 scaffold 测试预置浏览器端 chai。
 *
 * zotero-plugin-scaffold 在生成测试资源时会在 `.scaffold/cache/chai.js`
 * 找不到缓存的情况下，从 https://www.chaijs.com/chai.js 下载。CI 环境可能
 * 无法访问该站点（`TypeError: fetch failed`），导致测试在启动前失败。
 *
 * 这里把仓库内 `scripts/vendor/chai.js` 的 UMD 构建预置到缓存目录，使
 * scaffold 直接命中缓存，测试不再依赖外网。脚本是幂等的：缓存已存在且
 * 非空时不做任何事。
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_CHAI = resolve(ROOT, "scripts/vendor/chai.js");
const CACHE_DIR = resolve(ROOT, ".scaffold/cache");
const CACHE_CHAI = resolve(CACHE_DIR, "chai.js");

function isUsable(path) {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

if (isUsable(CACHE_CHAI)) {
  console.log("  [chai] .scaffold/cache/chai.js 已存在，跳过。");
} else if (!isUsable(VENDOR_CHAI)) {
  console.error(
    `  [chai] 缺少 vendored 文件：${VENDOR_CHAI}。无法为 scaffold 预置 chai。`,
  );
  process.exitCode = 1;
} else {
  mkdirSync(CACHE_DIR, { recursive: true });
  copyFileSync(VENDOR_CHAI, CACHE_CHAI);
  console.log(
    "  [chai] 已从 scripts/vendor/chai.js 预置 .scaffold/cache/chai.js",
  );
}
