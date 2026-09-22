import { assert } from "chai";
import {
  BOX_FALLBACK_COLOR,
  getBoxColor,
  getBoxColorTuple,
  getBoxFillColor,
  getBoxTypeColorStyles,
  toRgbChannels,
} from "../src/modules/readerOverlay/boxColors";

describe("boxColors", function () {
  it("maps official layout types to their palette color", function () {
    assert.deepEqual(getBoxColorTuple("text"), [0.6, 0.05, 0.3]);
    assert.deepEqual(getBoxColorTuple("ref_text"), [0.45, 0.2, 0.65]);
    assert.deepEqual(getBoxColorTuple("title"), [0.2, 0.2, 0.8]);
    assert.equal(getBoxColor("text"), "rgb(153, 13, 77)");
    assert.equal(getBoxFillColor("text", 0.15), "rgba(153, 13, 77, 0.15)");
  });

  it("normalizes type casing and falls back for unknown types", function () {
    assert.deepEqual(getBoxColorTuple(" TEXT "), [0.6, 0.05, 0.3]);
    assert.deepEqual(getBoxColorTuple("does-not-exist"), BOX_FALLBACK_COLOR);
  });

  it("exposes CSS-ready styles for every known type", function () {
    const styles = getBoxTypeColorStyles();
    assert.isAtLeast(styles.length, 1);
    const text = styles.find((entry) => entry.type === "text");
    assert.isDefined(text);
    assert.equal(text?.color, "rgb(153, 13, 77)");
    assert.equal(text?.hoverFill, "rgba(153, 13, 77, 0.3)");
  });

  it("converts 0-1 channels into bytes with clamping", function () {
    assert.deepEqual(toRgbChannels([0.6, 0.05, 0.3]), [153, 13, 77]);
    assert.deepEqual(toRgbChannels([-1, 2, 0]), [0, 255, 0]);
  });
});
