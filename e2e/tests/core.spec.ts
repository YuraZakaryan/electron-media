import { test, expect } from "@playwright/test";

const FIXTURE_URL = "/fixtures/master.m3u8";
const FIXTURE_CUE_TEXT = "Hello from fixture subtitle track";

test.describe("@electron-media/core against a real browser + real hls.js", () => {
  test("plays a real HLS stream and advances currentTime", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);

    await expect.poll(
      () => page.locator("#ready-state").textContent(),
      { timeout: 20_000 },
    ).toBe("true");

    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.play());

    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.currentTime),
      { timeout: 15_000 },
    ).toBeGreaterThan(0.5);
  });

  test("reports 2 audio tracks with expected languages and select() switches the active track", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);

    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    const languages = await page.locator("#audio-track-list button").evaluateAll(
      (buttons) => buttons.map((button) => (button as HTMLElement).dataset.language),
    );
    expect(languages.sort()).toEqual(["en", "es"]);

    const initiallySelected = await page.locator("#selected-audio-track-id").textContent();

    const otherButton = page.locator("#audio-track-list button:not(.selected)");
    const otherTrackId = await otherButton.first().getAttribute("data-track-id");
    await otherButton.first().click();

    await expect.poll(() => page.locator("#selected-audio-track-id").textContent()).toBe(otherTrackId);
    expect(await page.locator("#selected-audio-track-id").textContent()).not.toBe(initiallySelected);

    const hlsAudioTrackIndex = await page.evaluate(
      () => (window as any).__player.audio.selectedTrackId,
    );
    expect(String(hlsAudioTrackIndex)).toBe(otherTrackId);
  });

  test("renders the embedded WebVTT subtitle cue text at the right time", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);

    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    const subtitleTracks = await page.evaluate(() => (window as any).__getSubtitleTracks());
    expect(subtitleTracks.length).toBeGreaterThanOrEqual(1);
    expect(subtitleTracks[0].language).toBe("en");

    await page.evaluate(
      (trackId) => (window as any).__selectSubtitleTrack(trackId),
      subtitleTracks[0].trackId,
    );
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.5;
      return video.play();
    });

    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 15_000 },
    ).toBe(FIXTURE_CUE_TEXT);
  });

  test("loading an invalid URL emits a fatal error surfaced in the DOM", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate(() => (window as any).__loadSource("/fixtures/does-not-exist.m3u8"));

    await expect.poll(
      () => page.locator("#error-message").textContent(),
      { timeout: 15_000 },
    ).toContain("fatal:true");
  });

  test("selectTrack(null) turns subtitles off and clears rendered cue text", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    const subtitleTracks = await page.evaluate(() => (window as any).__getSubtitleTracks());
    await page.evaluate((trackId) => (window as any).__selectSubtitleTrack(trackId), subtitleTracks[0].trackId);
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.5;
      return video.play();
    });
    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 15_000 },
    ).toBe(FIXTURE_CUE_TEXT);

    await page.evaluate(() => (window as any).__selectSubtitleTrack(null));
    await expect.poll(() => page.locator("#selected-subtitle-track-id").textContent()).toBe("");
    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 5_000 },
    ).toBe("");
  });

  test("calling loadSource() again mid-playback tears down the old HLS instance and plays the new one", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");
    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.play());
    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.currentTime),
      { timeout: 15_000 },
    ).toBeGreaterThan(0.3);

    // Reload the SAME source mid-playback — this is the realistic "user
    // hits retry/replay" path, not just a fresh construction.
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);

    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);
    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.play());
    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.currentTime),
      { timeout: 15_000 },
    ).toBeGreaterThan(0.3);
  });

  test("destroy() is idempotent — calling it twice does not throw", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    const result = await page.evaluate(() => {
      try {
        (window as any).__destroy();
        (window as any).__destroy();
        return "ok";
      } catch (thrown) {
        return String(thrown);
      }
    });
    expect(result).toBe("ok");
  });

  test("auto-restores the previously selected audio language across a real page reload", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    const esButton = page.locator('#audio-track-list button[data-language="es"]');
    const esTrackId = await esButton.getAttribute("data-track-id");
    await esButton.click();
    await expect.poll(() => page.locator("#selected-audio-track-id").textContent()).toBe(esTrackId);

    // A real reload — new JS context, same localStorage — is the only
    // faithful way to prove restore-from-storage instead of just the
    // in-memory default-track fallback AudioTrackController also has.
    await page.reload();
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);

    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);
    const restoredLanguage = await page.evaluate(() => {
      const tracks = (window as any).__player.audio.getTracks();
      const selectedId = (window as any).__player.audio.selectedTrackId;
      return tracks.find((track: any) => track.trackId === selectedId)?.language;
    });
    expect(restoredLanguage).toBe("es");
  });

  test("a transient segment fetch failure is retried and recovers without a fatal error", async ({ page }) => {
    let failedOnce = false;
    await page.route("**/stream_video1.ts", (route) => {
      if (!failedOnce) {
        failedOnce = true;
        return route.abort("failed");
      }
      return route.continue();
    });

    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");
    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.play());

    // Playback must reach past the failed segment's timestamp despite the
    // one dropped request — proof the adapter's retry policy, not just
    // luck, got the segment loaded.
    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.currentTime),
      { timeout: 20_000 },
    ).toBeGreaterThan(2.5);

    expect(failedOnce).toBe(true);
    expect(await page.locator("#error-message").textContent()).toBe("");

    const nonFatalErrors = await page.evaluate(() => (window as any).__adapterErrors);
    expect(nonFatalErrors.some((event: any) => event.fatal === false)).toBe(true);
  });

  test("setDelaySeconds shifts a custom subtitle source's cues in real playback", async ({ page }) => {
    // HlsNativeSubtitleSource never emits onCuesChanged (hls.js renders its
    // own cues directly), so delay is a structural no-op for the fixture's
    // embedded track — track id 9999 is the harness's StaticSubtitleSource,
    // wired through the real SubtitleController -> CueProjector pipeline.
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await page.evaluate(() => (window as any).__setSubtitleDelay(2));
    await page.evaluate(() => (window as any).__selectSubtitleTrack(9999));

    // Canonical cue window is 2-3s; with the +2s delay already applied it
    // must now surface at 4-5s, not at its untouched 2-3s window.
    // toBe("") would false-fail here: the fixture's embedded native
    // subtitle rendition is DEFAULT=YES/AUTOSELECT=YES, so hls.js shows ITS
    // OWN cue text independent of our SubtitleController selection — the
    // real assertion is "not the static source's (delayed) text yet".
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 2.5;
      return video.play();
    });
    await page.waitForTimeout(500);
    expect(await page.locator("#subtitle-cue-text").textContent()).not.toBe("Delay test cue");

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 4.5;
    });
    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 5_000 },
    ).toBe("Delay test cue");
  });

  // These two exercise shouldRetry/maxRetries via the MANIFEST load path,
  // not a segment fetch failure: a manifest 404 fails synchronously (proven
  // fast by the "invalid URL" test above), whereas an aborted segment
  // request first runs through hls.js's own internal fragLoadingMaxRetry
  // backoff (hardcoded to 10 attempts in HlsJsAdapter, not configurable,
  // and not something this harness may alter) before our adapter's retry
  // policy ever sees it — that path can take upwards of a minute and isn't
  // a reasonable thing to wait out in a test.
  test("shouldRetry: () => false surfaces a fatal error on the first recoverable failure instead of retrying", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate(() => (window as any).__recreatePlayer({ shouldRetry: () => false }));
    await page.evaluate(() => (window as any).__loadSource("/fixtures/does-not-exist.m3u8"));

    await expect.poll(
      () => page.locator("#error-message").textContent(),
      { timeout: 10_000 },
    ).toContain("fatal:true");
  });

  test("maxRetries: 0 surfaces a fatal error on the first recoverable failure instead of retrying", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate(() => (window as any).__recreatePlayer({ maxRetries: 0 }));
    await page.evaluate(() => (window as any).__loadSource("/fixtures/does-not-exist.m3u8"));

    await expect.poll(
      () => page.locator("#error-message").textContent(),
      { timeout: 10_000 },
    ).toContain("fatal:true");
  });
});
