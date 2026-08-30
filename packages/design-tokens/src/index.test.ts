import { describe, expect, it } from "vitest";
import { motionTokens } from "./index";

describe("motionTokens", () => {
  it("keeps functional calendar motion short, composited, and removable", () => {
    expect(motionTokens.duration).toEqual({
      quickMs: 130,
      standardMs: 180,
      reducedMs: 0,
    });
    expect(motionTokens.properties).toEqual(["transform", "opacity"]);
    expect(motionTokens.easing.standard).toMatch(/^cubic-bezier\(/u);
  });
});
