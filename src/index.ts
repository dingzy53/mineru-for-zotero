import Addon from "./addon";
import { config } from "../package.json";

/**
 * 在极早的打包加载阶段安全获取 Zotero 对象。
 *
 * 正常情况下 `Zotero` 已在插件 scope 中可用；若尚未注入，则回退到
 * `chrome://zotero/content/zotero.mjs`，与旧 toolkit 的 `getGlobal` 行为一致。
 */
function getZotero(): typeof Zotero {
  if (typeof Zotero !== "undefined") {
    return Zotero;
  }
  return (
    ChromeUtils.importESModule(
      "chrome://zotero/content/zotero.mjs",
    ) as unknown as {
      Zotero: typeof Zotero;
    }
  ).Zotero;
}

// @ts-expect-error - Plugin instance is not typed
if (!getZotero()[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => _globalThis.addon.data.ztoolkit);
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: string, getter: () => unknown): void {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter();
    },
  });
}
