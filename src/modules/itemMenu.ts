import { config } from "../../package.json";
import { getLocaleID } from "../utils/locale";
import { isMinerUGeneratedAttachment, parseAttachments } from "./parseManager";
import { openTaskManagerWindow } from "./taskStore";

const PARSE_PDF_MENU_ID = `${config.addonRef}-parse-pdf`;
const TASK_MANAGER_MENU_ID = `${config.addonRef}-open-task-manager`;
const MENU_ICON = `chrome://${config.addonRef}/content/mineru.svg`;

type ItemMenuContext = {
  items?: Zotero.Item[];
  menuElem?: Element;
  setVisible: (visible: boolean) => void;
};

type MenuCommandContext = {
  items?: Zotero.Item[];
};

type MenuItemRegistration = {
  menuType: "menuitem";
  l10nID: string;
  icon: string;
  onCommand: (event: Event, context: MenuCommandContext) => void;
};

type MenuRegistration<TTarget extends string, TItem> = {
  menuID: string;
  pluginID: string;
  target: TTarget;
  menus: TItem[];
};

type ParsePdfMenuRegistration = MenuRegistration<
  "main/library/item",
  MenuItemRegistration & {
    onShowing: (event: Event, context: ItemMenuContext) => void;
  }
>;

type TaskManagerMenuRegistration = MenuRegistration<
  "main/menubar/tools",
  MenuItemRegistration
>;

type MenuManager = {
  registerMenu: (
    options: ParsePdfMenuRegistration | TaskManagerMenuRegistration,
  ) => string | false;
};

type ParsePdfMenuDependencies = {
  parseAttachments: (attachments: Zotero.Item[]) => Promise<void>;
};

type TaskManagerMenuDependencies = {
  openTaskManagerWindow: () => void;
};

export function registerItemMenu(menuManager = getMenuManager()): void {
  menuManager.registerMenu(createParsePdfMenuRegistration());
}

/** Adds "MinerU Task Manager" to the main window Tools menu. */
export function registerToolsMenu(menuManager = getMenuManager()): void {
  menuManager.registerMenu(createTaskManagerMenuRegistration());
}

export function createTaskManagerMenuRegistration(
  dependencies: TaskManagerMenuDependencies = {
    openTaskManagerWindow: () => openTaskManagerWindow(),
  },
): TaskManagerMenuRegistration {
  return {
    menuID: TASK_MANAGER_MENU_ID,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("tools-open-task-manager-menuitem"),
        icon: MENU_ICON,
        onCommand: () => {
          dependencies.openTaskManagerWindow();
        },
      },
    ],
  };
}

export function createParsePdfMenuRegistration(
  dependencies: ParsePdfMenuDependencies = { parseAttachments },
): ParsePdfMenuRegistration {
  return {
    menuID: PARSE_PDF_MENU_ID,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("parse-pdf-menuitem"),
        icon: MENU_ICON,
        onCommand: (_event, context) => {
          const attachments = (context.items ?? []).filter(isPdfAttachment);
          void dependencies.parseAttachments(attachments);
        },
        onShowing: (_event, context) => {
          const items = context.items ?? [];
          const visible = shouldShowParsePdfMenu(items);
          context.setVisible(visible);
          syncMenuGroupSeparator(context.menuElem, visible);
        },
      },
    ],
  };
}

export function shouldShowParsePdfMenu(items: Zotero.Item[]): boolean {
  return items.length > 0 && items.every(isPdfAttachment);
}

function isPdfAttachment(item: Zotero.Item): boolean {
  if (isMinerUGeneratedAttachment(item)) {
    return false;
  }
  return (
    typeof item.isAttachment === "function" &&
    typeof item.isPDFAttachment === "function" &&
    item.isAttachment() &&
    item.isPDFAttachment()
  );
}

function syncMenuGroupSeparator(
  menuElem: Element | undefined,
  visible: boolean,
): void {
  const separator = findCustomMenuGroupSeparator(menuElem);
  if (!separator) {
    return;
  }

  (separator as HTMLElement).hidden =
    !visible && !hasVisibleCustomMenuItemAfter(separator);
}

function findCustomMenuGroupSeparator(
  menuElem: Element | undefined,
): Element | null {
  if (!menuElem?.parentElement) {
    return null;
  }

  let sibling = menuElem.previousElementSibling;
  while (sibling?.classList.contains("zotero-custom-menu-item")) {
    if (sibling.classList.contains("zotero-custom-menu-group-separator")) {
      return sibling;
    }
    sibling = sibling.previousElementSibling;
  }

  return null;
}

function hasVisibleCustomMenuItemAfter(separator: Element): boolean {
  let sibling = separator.nextElementSibling;
  while (sibling?.classList.contains("zotero-custom-menu-item")) {
    if (
      !sibling.classList.contains("zotero-custom-menu-group-separator") &&
      !isHiddenElement(sibling)
    ) {
      return true;
    }
    sibling = sibling.nextElementSibling;
  }
  return false;
}

function isHiddenElement(element: Element): boolean {
  return Boolean(
    (element as HTMLElement).hidden ||
    element.getAttribute("hidden") === "true" ||
    element.getAttribute("collapsed") === "true",
  );
}

function getMenuManager(): MenuManager {
  return Zotero.MenuManager as unknown as MenuManager;
}
