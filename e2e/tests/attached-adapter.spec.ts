import { test, expect } from "@playwright/test";

const FIXTURE_URL = "/fixtures/master.m3u8";
const FIXTURE_CUE_TEXT = "Hello from fixture subtitle track";

test.describe("AttachedHlsAdapter against a real browser + real hls.js (host-owned Hls instance)", () => {
  test("reports 2 audio tracks with expected languages and select() switches the active track", async ({ page }) => {
    await page.goto("/attached-adapter.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);

    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    const languages = await page.locator("#audio-track-list button").evaluateAll(
      (buttons) => buttons.map((button) => (button as HTMLElement).dataset.language),
    );
    expect(languages.sort()).toEqual(["en", "es"]);

    const otherButton = page.locator("#audio-track-list button:not(.selected)");
    const otherTrackId = await otherButton.first().getAttribute("data-track-id");
    await otherButton.first().click();

    await expect.poll(() => page.locator("#selected-audio-track-id").textContent()).toBe(otherTrackId);
  });

  test("renders and switches the embedded WebVTT subtitle track the same way the owning adapter does", async ({ page }) => {
    await page.goto("/attached-adapter.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    const subtitleTracks = await page.evaluate(() => (window as any).__getSubtitleTracks());
    expect(subtitleTracks.length).toBeGreaterThanOrEqual(1);

    await page.evaluate((trackId) => (window as any).__selectSubtitleTrack(trackId), subtitleTracks[0].trackId);
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.5;
      return video.play();
    });

    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 15_000 },
    ).toBe(FIXTURE_CUE_TEXT);
  });

  test("a correctly-paired destroy+detachHls, then a fresh attachHls, repopulates track lists from the new instance", async ({ page }) => {
    await page.goto("/attached-adapter.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    // Simulates a VOD seek/transcode session swap: the harness's
    // createAndAttach() destroys the old Hls instance AND calls
    // detachHls() before attaching the new one — the correct pairing this
    // whole effort exists to make the default, easy-to-get-right path.
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);

    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");
  });

  test("keeps the user's audio track choice across a destroy + rebuild of the Hls instance (seek)", async ({ page }) => {
    await page.goto("/attached-adapter.html");
    await page.evaluate(() => localStorage.removeItem("e2e-attached-audio-language"));
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    // Pick whichever track is not the auto-selected default.
    const otherButton = page.locator("#audio-track-list button:not(.selected)").first();
    const chosenLanguage = await otherButton.getAttribute("data-language");
    const chosenTrackId = await otherButton.getAttribute("data-track-id");
    await otherButton.click();
    await expect.poll(() => page.locator("#selected-audio-track-id").textContent()).toBe(chosenTrackId);
    await expect.poll(() => page.evaluate(() => (window as any).__getHlsAudioTrack())).toBe(
      Number(chosenTrackId),
    );

    // A full re-transcode seek: the host destroys its Hls instance, detaches,
    // and attaches a brand-new one. The replacement carries no selection of
    // its own, so the stored language has to be re-applied — it used to fall
    // back to the manifest default instead.
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    // Asserted against the engine, not the controller/UI: the controller keeps
    // reporting the old pick either way, so only hls.audioTrack reveals
    // whether the choice actually reached the new instance.
    await expect.poll(
      () => page.evaluate(() => (window as any).__getHlsAudioTrack()),
      { timeout: 10_000 },
    ).toBe(Number(chosenTrackId));

    const selectedLanguage = await page.evaluate(
      (trackId) =>
        (window as any)
          .__getAudioTracks()
          .find((track: { trackId: number }) => track.trackId === trackId)?.language,
      Number(chosenTrackId),
    );
    expect(selectedLanguage).toBe(chosenLanguage);
  });

  test("bad case: destroying and recreating the Hls instance WITHOUT calling detachHls does not throw or hang, and the new instance's tracks still populate", async ({ page }) => {
    await page.goto("/attached-adapter.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // Reproduces the exact app-side bug (resetPlaybackVideo()/onClose()
    // destroying Hls without calling detachHls()) — the adapter itself
    // must survive this misuse, even though closing this gap for real is
    // an app-side fix, not something this library can do on its own.
    await page.evaluate((url) => (window as any).__reloadWithoutDetach(url), FIXTURE_URL);

    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);
    expect(pageErrors).toEqual([]);
  });

  test("a selected VOD-extracted track keeps rendering after its source instance is replaced (seek)", async ({ page }) => {
    await page.goto("/attached-adapter.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    const parkAt = async (seconds: number) => {
      await page.locator("#video").evaluate((video: HTMLVideoElement, at) => {
        video.pause();
        video.currentTime = at;
      }, seconds);
    };

    await parkAt(4);
    await page.evaluate(() =>
      (window as any).__selectSubtitleTrack((window as any).__vodTrackId),
    );
    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 10_000 },
    ).toBe("Second fixture subtitle cue");

    // A faithful seek: the host swaps in a new source instance for the new
    // session AND rebuilds its Hls instance. Both halves matter — the rebuild
    // wipes every TextTrack hls.js does not own (so the cue already on screen
    // disappears), and the swap orphans the controller's cue subscription on
    // the disposed instance. Nothing re-selects the track, so the controller
    // has to notice the swap itself; it used to leave the replacement idle and
    // the track stayed selected while rendering nothing until the user picked
    // it again.
    await page.evaluate(() => (window as any).__replaceVodSource());
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    // The replacement shifts the same .vtt by its own 3.5s baseline, so the
    // third fixture cue (5.5s–7.5s in the file) now covers 2s–4s. Asserting on
    // *that* is what makes the test discriminating: cues held over from the
    // disposed instance are unshifted, leaving nothing on screen at this
    // position, so a stale binding cannot pass.
    await parkAt(3.2);

    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 10_000 },
    ).toBe("Third fixture subtitle cue");
  });

  test("bad case: loading an invalid URL surfaces a fatal error without an unhandled exception", async ({ page }) => {
    await page.goto("/attached-adapter.html");

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.evaluate(() => (window as any).__loadSource("/fixtures/does-not-exist.m3u8"));

    await expect.poll(
      () => page.locator("#error-message").textContent(),
      { timeout: 15_000 },
    ).toContain("fatal:true");
    expect(pageErrors).toEqual([]);
  });

  test("bad case: detachHls after the video element has been removed from the DOM does not throw", async ({ page }) => {
    await page.goto("/attached-adapter.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.evaluate(() => (window as any).__removeVideoFromDom());
    await page.evaluate(() => (window as any).__detach());

    expect(pageErrors).toEqual([]);
  });
});
