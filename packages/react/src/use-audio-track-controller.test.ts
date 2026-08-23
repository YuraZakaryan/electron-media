import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { asAudioTrackId, AudioTrackController, TrackKind } from "@electron-media/core";

import { useAudioTrackController } from "./use-audio-track-controller.js";
import { MockHlsAdapter } from "./testing/mock-hls-adapter.js";

import type { UseAudioTrackControllerResult } from "./use-audio-track-controller.js";

function TestComponent(props: {
  controller: AudioTrackController | null;
  onResult: (result: UseAudioTrackControllerResult) => void;
}) {
  const result = useAudioTrackController(props.controller);
  props.onResult(result);
  return null;
}

function setup(initialController: AudioTrackController | null) {
  let latest!: UseAudioTrackControllerResult;
  const onResult = (result: UseAudioTrackControllerResult) => {
    latest = result;
  };

  const utils = render(
    React.createElement(TestComponent, { controller: initialController, onResult })
  );

  return {
    get result() {
      return latest;
    },
    rerenderWith: (controller: AudioTrackController | null) =>
      utils.rerender(React.createElement(TestComponent, { controller, onResult })),
    unmount: utils.unmount,
  };
}

describe("useAudioTrackController", () => {
  afterEach(() => {
    cleanup();
  });

  it("returns empty state and select() is a harmless no-op when given null", () => {
    const harness = setup(null);

    expect(harness.result.state.tracks).toEqual([]);
    expect(harness.result.state.selectedTrack).toBeNull();
    expect(() => act(() => harness.result.actions.select(asAudioTrackId(0)))).not.toThrow();
  });

  it("reflects tracks reported by the controller and proxies select()", () => {
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });
    const harness = setup(controller);

    const tracks = [
      { trackId: asAudioTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default },
      { trackId: asAudioTrackId(1), displayName: "Spanish", language: "es", kind: TrackKind.Manual },
    ];
    act(() => {
      adapter.audioTracks = tracks;
      adapter.emit("audioTracksChanged", { tracks });
    });

    expect(harness.result.state.tracks).toEqual(tracks);
    // AudioTrackController auto-selects the "default" track on first list update.
    expect(harness.result.state.selectedTrack).toEqual(tracks[0]);

    act(() => harness.result.actions.select(asAudioTrackId(1)));

    expect(adapter.selectedAudioTrackId).toBe(1);
    expect(harness.result.state.selectedTrack).toEqual(tracks[1]);
  });

  it("resets to empty state when the controller prop transitions to null", () => {
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });
    const harness = setup(controller);

    const tracks = [
      { trackId: asAudioTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default },
    ];
    act(() => {
      adapter.audioTracks = tracks;
      adapter.emit("audioTracksChanged", { tracks });
    });
    expect(harness.result.state.tracks).toEqual(tracks);

    harness.rerenderWith(null);

    expect(harness.result.state.tracks).toEqual([]);
    expect(harness.result.state.selectedTrack).toBeNull();
  });

  it("populates state once the controller prop transitions from null to a real instance — mirrors a host constructing the controller in a mount effect one render after the initial null", () => {
    const harness = setup(null);
    expect(harness.result.state.tracks).toEqual([]);

    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });
    harness.rerenderWith(controller);

    const tracks = [
      { trackId: asAudioTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default },
      { trackId: asAudioTrackId(1), displayName: "Spanish", language: "es", kind: TrackKind.Manual },
    ];
    act(() => {
      adapter.audioTracks = tracks;
      adapter.emit("audioTracksChanged", { tracks });
    });

    expect(harness.result.state.tracks).toEqual(tracks);
    expect(harness.result.state.selectedTrack).toEqual(tracks[0]);
  });

  it("switches subscriptions cleanly when the controller instance itself changes, ignoring later events from the old one", () => {
    const adapterA = new MockHlsAdapter();
    const controllerA = new AudioTrackController({ adapter: adapterA });
    const harness = setup(controllerA);

    const tracksA = [
      { trackId: asAudioTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default },
    ];
    act(() => {
      adapterA.audioTracks = tracksA;
      adapterA.emit("audioTracksChanged", { tracks: tracksA });
    });
    expect(harness.result.state.tracks).toEqual(tracksA);

    const adapterB = new MockHlsAdapter();
    const controllerB = new AudioTrackController({ adapter: adapterB });
    harness.rerenderWith(controllerB);

    expect(harness.result.state.tracks).toEqual([]);

    const staleTracks = [
      { trackId: asAudioTrackId(5), displayName: "Stale", language: "xx", kind: TrackKind.Manual },
    ];
    act(() => {
      adapterA.audioTracks = staleTracks;
      adapterA.emit("audioTracksChanged", { tracks: staleTracks });
    });
    expect(harness.result.state.tracks).toEqual([]);
  });

  it("keeps actions referentially stable across re-renders while the controller instance is unchanged", () => {
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });
    const harness = setup(controller);

    const firstActions = harness.result.actions;
    harness.rerenderWith(controller);

    expect(harness.result.actions).toBe(firstActions);
  });
});
