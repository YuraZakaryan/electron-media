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
