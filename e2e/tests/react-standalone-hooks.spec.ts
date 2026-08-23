import { test, expect } from "@playwright/test";

const FIXTURE_URL = "/fixtures/master.m3u8";
const FIXTURE_CUE_TEXT = "Hello from fixture subtitle track";

function harnessUrl(src: string): string {
  return `/react-standalone.html?src=${encodeURIComponent(src)}`;
}

test.describe("standalone useAudioTrackController/useSubtitleController/useVoiceOverController against a real browser + real hls.js", () => {
  test("renders 2 audio track buttons and clicking one switches selectedAudioTrack in the DOM", async ({ page }) => {
    await page.goto(harnessUrl(FIXTURE_URL));

    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    const initiallySelected = await page.locator("#selected-audio-track-id").textContent();
    const otherButtonBeforeClick = page.locator("#audio-track-list button:not(.selected)").first();
    const otherTrackId = await otherButtonBeforeClick.getAttribute("data-track-id");
    const clickedButton = page.locator(`#audio-track-list button[data-track-id="${otherTrackId}"]`);
    await clickedButton.click();

    await expect.poll(() => page.locator("#selected-audio-track-id").textContent()).toBe(otherTrackId);
    expect(await page.locator("#selected-audio-track-id").textContent()).not.toBe(initiallySelected);
    await expect(clickedButton).toHaveClass(/selected/);
  });

  test("renders the VOD-extracted subtitle cue text at the right time", async ({ page }) => {
    await page.goto(harnessUrl(FIXTURE_URL));

    await expect.poll(
      () => page.locator("#subtitle-track-list li").count(),
      { timeout: 20_000 },
    ).toBe(1);

    await page.locator("#subtitle-track-list button").first().click();
    await expect(page.locator("#subtitle-track-list button").first()).toHaveClass(/selected/);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.5;
      return video.play();
    });

    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 15_000 },
    ).toBe(FIXTURE_CUE_TEXT);
  });

  test("binding voice-over to the VOD-extracted track and selecting a language reaches a real cue and requests synthesis", async ({ page }) => {
    await page.goto(harnessUrl(FIXTURE_URL));

    await page.locator("#voiceover-bind-vod-track-button").click();

    await expect.poll(
      () => page.locator("#voiceover-track-list li").count(),
      { timeout: 20_000 },
    ).toBe(1);

    await page.locator("#voiceover-track-list button").first().click();
    await expect(page.locator("#voiceover-track-list button").first()).toHaveClass(/selected/);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 0.5;
      return video.play();
    });

    // Proves the full pipe works through the standalone hook + host-
    // constructed VoiceOverController: real video.currentTime advancing via
    // real hls.js playback drives the real scheduler, which requests
    // synthesis for the cue at 1s-3s once it's within lookahead range.
    await expect.poll(
      () => page.evaluate(() => (window as any).__voiceOverGenerateLineCallCount()),
      { timeout: 15_000 },
    ).toBeGreaterThan(0);
  });
});
