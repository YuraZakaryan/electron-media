import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  asSubtitleSourceId,
  asSubtitleTrackId,
  HlsNativeSubtitleSource,
  SubtitleController,
  SubtitleDelayProcessor,
  SubtitleRegistry,
  SubtitleSelectionService,
  TrackKind,
} from "@electron-media/core";

import { useSubtitleController } from "./use-subtitle-controller.js";
import { MockHlsAdapter } from "./testing/mock-hls-adapter.js";

import type { UseSubtitleControllerResult } from "./use-subtitle-controller.js";

function TestComponent(props: {
  controller: SubtitleController | null;
  onResult: (result: UseSubtitleControllerResult) => void;
}) {
  const result = useSubtitleController(props.controller);
  props.onResult(result);
  return null;
}

function setup(initialController: SubtitleController | null) {
  let latest!: UseSubtitleControllerResult;
  const onResult = (result: UseSubtitleControllerResult) => {
    latest = result;
  };

  const utils = render(
    React.createElement(TestComponent, { controller: initialController, onResult })
  );

  return {
    get result() {
      return latest;
    },
    rerenderWith: (controller: SubtitleController | null) =>
      utils.rerender(React.createElement(TestComponent, { controller, onResult })),
    unmount: utils.unmount,
  };
}

// subtitleRenderer is stubbed because jsdom doesn't implement
// HTMLMediaElement.addTextTrack(), which the default renderer needs — the
// same workaround core's own subtitle-controller.test.ts uses.
function createController(adapter: MockHlsAdapter, sourceId = asSubtitleSourceId("hls-native")) {
  const source = new HlsNativeSubtitleSource({ sourceId, adapter });
  const registry = new SubtitleRegistry({ sources: [source] });
  const selection = new SubtitleSelectionService({ registry });
  const delay = new SubtitleDelayProcessor();
  const renderer = { render: () => {}, clear: () => {} };
  return new SubtitleController({ registry, selection, delay, renderer });
}

describe("useSubtitleController", () => {
  afterEach(() => {
    cleanup();
  });

  it("returns empty state, and selectTrack/setDelaySeconds are harmless no-ops, when given null", () => {
    const harness = setup(null);

    expect(harness.result.state.tracks).toEqual([]);
    expect(harness.result.state.selectedTrack).toBeNull();
    expect(() =>
      act(() => harness.result.actions.selectTrack(asSubtitleTrackId(0)))
    ).not.toThrow();
    expect(() => act(() => harness.result.actions.setDelaySeconds(2))).not.toThrow();
  });

  it("reflects tracks reported through the registered source and proxies selectTrack/setDelaySeconds", () => {
    const adapter = new MockHlsAdapter();
    const sourceId = asSubtitleSourceId("hls-native");
    const controller = createController(adapter, sourceId);
    const harness = setup(controller);

    const tracks = [
      { trackId: asSubtitleTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default, sourceId },
    ];
    act(() => {
      adapter.subtitleTracks = tracks;
      adapter.emit("subtitleTracksChanged", { tracks });
    });

    expect(harness.result.state.tracks).toEqual(tracks);
    expect(harness.result.state.selectedTrack).toBeNull();

    act(() => harness.result.actions.selectTrack(asSubtitleTrackId(0)));
    expect(adapter.selectedSubtitleTrackId).toBe(0);
    expect(harness.result.state.selectedTrack).toEqual(tracks[0]);

    expect(() => act(() => harness.result.actions.setDelaySeconds(2))).not.toThrow();
  });

  it("populates state once the controller prop transitions from null to a real instance — mirrors a host constructing the controller in a mount effect one render after the initial null", () => {
    const harness = setup(null);
    expect(harness.result.state.tracks).toEqual([]);

    const adapter = new MockHlsAdapter();
    const sourceId = asSubtitleSourceId("hls-native");
    const controller = createController(adapter, sourceId);
    harness.rerenderWith(controller);

    const tracks = [
      { trackId: asSubtitleTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default, sourceId },
    ];
    act(() => {
      adapter.subtitleTracks = tracks;
      adapter.emit("subtitleTracksChanged", { tracks });
    });

    expect(harness.result.state.tracks).toEqual(tracks);

    act(() => harness.result.actions.selectTrack(asSubtitleTrackId(0)));
    expect(adapter.selectedSubtitleTrackId).toBe(0);
    expect(harness.result.state.selectedTrack).toEqual(tracks[0]);
  });

  it("resets to empty state when the controller prop transitions to null", () => {
    const adapter = new MockHlsAdapter();
    const sourceId = asSubtitleSourceId("hls-native");
    const controller = createController(adapter, sourceId);
    const harness = setup(controller);

    const tracks = [
      { trackId: asSubtitleTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default, sourceId },
    ];
    act(() => {
      adapter.subtitleTracks = tracks;
      adapter.emit("subtitleTracksChanged", { tracks });
    });
    expect(harness.result.state.tracks).toEqual(tracks);

    harness.rerenderWith(null);

    expect(harness.result.state.tracks).toEqual([]);
    expect(harness.result.state.selectedTrack).toBeNull();
  });

  it("keeps actions referentially stable across re-renders while the controller instance is unchanged", () => {
    const adapter = new MockHlsAdapter();
    const controller = createController(adapter);
    const harness = setup(controller);

    const firstActions = harness.result.actions;
    harness.rerenderWith(controller);

    expect(harness.result.actions).toBe(firstActions);
  });
});
