/**
 * MinerU 官方 layout.pdf 的类型配色（docvortex.visualization._BLOCK_COLORS）。
 *
 * 这里同时收录归一化后的类型与官方原始类型，保证 Middle JSON 2.0 与 legacy
 * `pdf_info` 结果都能命中同一套颜色。颜色为 0-1 浮点 RGB，保持与官方一致便于校对。
 */
export type BoxColorTuple = readonly [number, number, number];

/** 官方未覆盖类型时的兜底色，对应 docvortex 的 (0.90, 0.10, 0.10)。 */
export const BOX_FALLBACK_COLOR: BoxColorTuple = [0.9, 0.1, 0.1];

/** 框内半透明填充透明度，官方 layout.pdf 的视觉近似值。 */
export const BOX_FILL_ALPHA = 0.15;
/** hover 时加深的填充透明度。 */
export const BOX_HOVER_FILL_ALPHA = 0.3;

const PAGE_AUXILIARY_GRAY: BoxColorTuple = [158 / 255, 158 / 255, 158 / 255];

export const BOX_TYPE_COLORS: Record<string, BoxColorTuple> = {
  text: [0.6, 0.05, 0.3],
  paragraph: [0.6, 0.05, 0.3],
  doc_title: [0.2, 0.2, 0.8],
  title: [0.2, 0.2, 0.8],
  paragraph_title: [0.2, 0.4, 0.9],
  ref_text: [0.45, 0.2, 0.65],
  reference: [0.45, 0.2, 0.65],
  citation: [0.45, 0.2, 0.65],
  bibliography: [0.45, 0.2, 0.65],
  equation: [0.0, 0.6, 0.1],
  formula: [0.0, 0.6, 0.1],
  interline_equation: [0.0, 0.6, 0.1],
  equation_interline: [0.0, 0.6, 0.1],
  inline_equation: [0.0, 0.6, 0.1],
  equation_inline: [0.0, 0.6, 0.1],
  list: [0.1, 0.6, 0.35],
  index: [0.1, 0.6, 0.35],
  image: [0.3, 0.85, 0.05],
  figure: [0.3, 0.85, 0.05],
  image_body: [0.3, 0.85, 0.05],
  image_caption: [0.1, 0.55, 0.9],
  image_footnote: [0.95, 0.45, 0.1],
  table: [0.8, 0.8, 0.0],
  table_body: [0.8, 0.8, 0.0],
  table_caption: [1.0, 0.85, 0.1],
  table_footnote: [0.55, 0.9, 0.25],
  chart: [0.3, 0.85, 0.05],
  chart_body: [0.3, 0.85, 0.05],
  chart_caption: [0.1, 0.55, 0.9],
  chart_footnote: [0.95, 0.45, 0.1],
  code: [0.4, 0.0, 0.8],
  code_body: [0.4, 0.0, 0.8],
  algorithm: [0.4, 0.0, 0.8],
  algorithm_body: [0.4, 0.0, 0.8],
  code_caption: [0.7, 0.35, 0.95],
  code_footnote: [0.85, 0.7, 0.95],
  page_footnote: [0.0, 128 / 255, 128 / 255],
  footnote: [0.0, 128 / 255, 128 / 255],
  page_header: PAGE_AUXILIARY_GRAY,
  header: PAGE_AUXILIARY_GRAY,
  page_footer: PAGE_AUXILIARY_GRAY,
  footer: PAGE_AUXILIARY_GRAY,
  page_number: PAGE_AUXILIARY_GRAY,
  aside_text: PAGE_AUXILIARY_GRAY,
  page_aside_text: PAGE_AUXILIARY_GRAY,
  phonetic: PAGE_AUXILIARY_GRAY,
  unknown: PAGE_AUXILIARY_GRAY,
};

export interface BoxTypeColorStyle {
  type: string;
  /** 描边与标签使用的实色，如 `rgb(153, 13, 77)`。 */
  color: string;
  /** 框内半透明填充，如 `rgba(153, 13, 77, 0.15)`。 */
  fill: string;
  /** hover 高亮填充。 */
  hoverFill: string;
}

/** 解析类型对应的官方配色，未知类型回退到红色。 */
export function getBoxColorTuple(type: string): BoxColorTuple {
  const normalized = normalizeColorType(type);
  return BOX_TYPE_COLORS[normalized] ?? BOX_FALLBACK_COLOR;
}

/** 生成类型对应的描边实色。 */
export function getBoxColor(type: string): string {
  const [red, green, blue] = toRgbChannels(getBoxColorTuple(type));
  return `rgb(${red}, ${green}, ${blue})`;
}

/** 生成类型对应的半透明填充色。 */
export function getBoxFillColor(type: string, alpha = BOX_FILL_ALPHA): string {
  const [red, green, blue] = toRgbChannels(getBoxColorTuple(type));
  return `rgba(${red}, ${green}, ${blue}, ${formatAlpha(alpha)})`;
}

/**
 * 展开成可直接写入 CSS 的 `data-mineru-box-type` 规则数据。
 * 使用 CSS 变量而非内联样式，避免给每个 box 写 style 属性。
 */
export function getBoxTypeColorStyles(): BoxTypeColorStyle[] {
  return Object.keys(BOX_TYPE_COLORS).map((type) => ({
    type,
    color: getBoxColor(type),
    fill: getBoxFillColor(type, BOX_FILL_ALPHA),
    hoverFill: getBoxFillColor(type, BOX_HOVER_FILL_ALPHA),
  }));
}

/** 把 0-1 浮点 RGB 转成 0-255 整数通道。 */
export function toRgbChannels(tuple: BoxColorTuple): [number, number, number] {
  return [
    channelToByte(tuple[0]),
    channelToByte(tuple[1]),
    channelToByte(tuple[2]),
  ];
}

function channelToByte(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 255);
}

function formatAlpha(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Number(clamped.toFixed(3));
}

function normalizeColorType(type: string): string {
  return String(type ?? "")
    .trim()
    .toLowerCase();
}
