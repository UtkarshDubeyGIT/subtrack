export const motionTokens = {
  duration: {
    quickMs: 130,
    standardMs: 180,
    reducedMs: 0,
  },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
  },
  properties: ["transform", "opacity"],
} as const;
