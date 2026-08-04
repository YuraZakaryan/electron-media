import { describe, expect, it, vi } from "vitest";

import { SubtitleDelayProcessor } from "./subtitle-delay-processor.js";

describe("SubtitleDelayProcessor", () => {
  it("defaults to zero delay", () => {
    const processor = new SubtitleDelayProcessor();
    expect(processor.getDelaySeconds()).toBe(0);
  });

  it("applies a positive delay to a cue", () => {
    const processor = new SubtitleDelayProcessor();
    processor.setDelaySeconds(1.5);
    expect(
      processor.apply({ startSeconds: 10, endSeconds: 12, text: "x" })
    ).toEqual({ startSeconds: 11.5, endSeconds: 13.5, text: "x" });
  });

  it("applies a negative delay to a cue", () => {
    const processor = new SubtitleDelayProcessor();
    processor.setDelaySeconds(-2);
    expect(
      processor.apply({ startSeconds: 10, endSeconds: 12, text: "x" })
    ).toEqual({ startSeconds: 8, endSeconds: 10, text: "x" });
  });

  it("applies a large delay without clamping", () => {
    const processor = new SubtitleDelayProcessor();
    processor.setDelaySeconds(500);
    expect(
      processor.apply({ startSeconds: 10, endSeconds: 12, text: "x" })
    ).toEqual({ startSeconds: 510, endSeconds: 512, text: "x" });
  });

  it("notifies subscribers when the delay changes", () => {
    const processor = new SubtitleDelayProcessor();
    const listener = vi.fn();
    processor.onDelayChanged(listener);

    processor.setDelaySeconds(3);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(3);
  });

  it("does not notify subscribers when set to the same value", () => {
    const processor = new SubtitleDelayProcessor();
    processor.setDelaySeconds(3);
    const listener = vi.fn();
    processor.onDelayChanged(listener);

    processor.setDelaySeconds(3);

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying once unsubscribed", () => {
    const processor = new SubtitleDelayProcessor();
    const listener = vi.fn();
    const unsubscribe = processor.onDelayChanged(listener);

    unsubscribe();
    processor.setDelaySeconds(1);

    expect(listener).not.toHaveBeenCalled();
  });
});
