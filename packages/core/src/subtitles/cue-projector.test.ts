import { describe, expect, it } from "vitest";

import { CueProjector } from "./cue-projector.js";

describe("CueProjector", () => {
  const cue = { startSeconds: 10, endSeconds: 12, text: "hi" };

  it("shifts both start and end later for a positive delay", () => {
    const projector = new CueProjector();
    expect(projector.project(cue, 2)).toEqual({
      startSeconds: 12,
      endSeconds: 14,
      text: "hi",
    });
  });

  it("shifts both start and end earlier for a negative delay", () => {
    const projector = new CueProjector();
    expect(projector.project(cue, -3)).toEqual({
      startSeconds: 7,
      endSeconds: 9,
      text: "hi",
    });
  });

  it("returns an equivalent cue for a zero delay", () => {
    const projector = new CueProjector();
    expect(projector.project(cue, 0)).toEqual(cue);
  });

  it("does not mutate the input cue", () => {
    const projector = new CueProjector();
    const original = { ...cue };
    projector.project(cue, 5);
    expect(cue).toEqual(original);
  });

  it("can shift a cue's start below zero (clamping is the caller's job)", () => {
    const projector = new CueProjector();
    expect(projector.project(cue, -20)).toEqual({
      startSeconds: -10,
      endSeconds: -8,
      text: "hi",
    });
  });
});
