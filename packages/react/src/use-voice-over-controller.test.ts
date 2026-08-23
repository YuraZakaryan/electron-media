import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { asVoiceOverTrackId, TypedEventEmitter, VoiceOverController } from "@electron-media/core";

import { useVoiceOverController } from "./use-voice-over-controller.js";
import { MockVoiceOverGateway } from "./testing/mock-voiceover-gateway.js";

import type { PlayerEvents } from "@electron-media/core";
import type { UseVoiceOverControllerResult } from "./use-voice-over-controller.js";

function TestComponent(props: {
  controller: VoiceOverController | null;
  onResult: (result: UseVoiceOverControllerResult) => void;
}) {
  const result = useVoiceOverController(props.controller);
  props.onResult(result);
  return null;
}

function setup(initialController: VoiceOverController | null) {
  let latest!: UseVoiceOverControllerResult;
  const onResult = (result: UseVoiceOverControllerResult) => {
    latest = result;
  };

  const utils = render(
    React.createElement(TestComponent, { controller: initialController, onResult })
  );

  return {
    get result() {
      return latest;
    },
    rerenderWith: (controller: VoiceOverController | null) =>
      utils.rerender(React.createElement(TestComponent, { controller, onResult })),
    unmount: utils.unmount,
  };
}

function createController(gateway: MockVoiceOverGateway) {
  const events = new TypedEventEmitter<PlayerEvents>();
  return new VoiceOverController({ gateway, events });
}

describe("useVoiceOverController", () => {
  afterEach(() => {
    cleanup();
  });

  it("returns empty state, and every action is a harmless no-op, when given null", () => {
    const harness = setup(null);

    expect(harness.result.state.tracks).toEqual([]);
    expect(harness.result.state.selectedTrack).toBeNull();
    expect(harness.result.state.isGenerating).toBe(false);
    expect(() =>
      act(() => harness.result.actions.selectTrack(asVoiceOverTrackId("en")))
    ).not.toThrow();
    expect(() => act(() => harness.result.actions.disableVoiceOver())).not.toThrow();
    expect(() =>
      act(() => harness.result.actions.bindSubtitleSource(null, null))
    ).not.toThrow();
    expect(() => act(() => harness.result.actions.setDuckVolume(0.5))).not.toThrow();
    expect(() => act(() => harness.result.actions.setVoiceOverVolume(0.8))).not.toThrow();
    expect(() => act(() => harness.result.actions.setLookaheadSeconds(3))).not.toThrow();
    expect(() => act(() => harness.result.actions.setAllowVideoPause(true))).not.toThrow();
  });

  it("populates state.tracks from the gateway and selectTrack/disableVoiceOver proxy to the controller", async () => {
    const gateway = new MockVoiceOverGateway();
    gateway.voices = [{ languageCode: "en", displayName: "English" }];
    const controller = createController(gateway);
    const harness = setup(controller);

    await act(async () => {
      await Promise.resolve();
    });

    expect(harness.result.state.tracks).toEqual([
      { trackId: asVoiceOverTrackId("en"), displayName: "English", language: "en", kind: "dub", sourceId: expect.any(String) },
    ]);

    act(() => harness.result.actions.selectTrack(asVoiceOverTrackId("en")));
    expect(harness.result.state.selectedTrack?.language).toBe("en");

    act(() => harness.result.actions.disableVoiceOver());
    expect(harness.result.state.selectedTrack).toBeNull();
  });

  it("state.isGenerating starts false and unmount does not throw once actively subscribed", async () => {
    const gateway = new MockVoiceOverGateway();
    const controller = createController(gateway);
    const harness = setup(controller);

    await act(async () => {
      await Promise.resolve();
    });

    expect(harness.result.state.isGenerating).toBe(false);
    expect(() => harness.unmount()).not.toThrow();
  });

  it("populates state.tracks once the controller prop transitions from null to a real instance — mirrors a host constructing the controller in a mount effect one render after the initial null", async () => {
    const gateway = new MockVoiceOverGateway();
    gateway.voices = [{ languageCode: "en", displayName: "English" }];
    const harness = setup(null);
    expect(harness.result.state.tracks).toEqual([]);

    const controller = createController(gateway);
    harness.rerenderWith(controller);

    await act(async () => {
      await Promise.resolve();
    });

    expect(harness.result.state.tracks).toEqual([
      { trackId: asVoiceOverTrackId("en"), displayName: "English", language: "en", kind: "dub", sourceId: expect.any(String) },
    ]);

    act(() => harness.result.actions.selectTrack(asVoiceOverTrackId("en")));
    expect(harness.result.state.selectedTrack?.language).toBe("en");
  });

  it("resets to empty state when the controller prop transitions to null", async () => {
    const gateway = new MockVoiceOverGateway();
    gateway.voices = [{ languageCode: "en", displayName: "English" }];
    const controller = createController(gateway);
    const harness = setup(controller);

    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.result.state.tracks.length).toBe(1);

    harness.rerenderWith(null);

    expect(harness.result.state.tracks).toEqual([]);
    expect(harness.result.state.selectedTrack).toBeNull();
    expect(harness.result.state.isGenerating).toBe(false);
  });

  it("keeps actions referentially stable across re-renders while the controller instance is unchanged", async () => {
    const gateway = new MockVoiceOverGateway();
    const controller = createController(gateway);
    const harness = setup(controller);

    await act(async () => {
      await Promise.resolve();
    });

    const firstActions = harness.result.actions;
    harness.rerenderWith(controller);

    expect(harness.result.actions).toBe(firstActions);
  });
});
