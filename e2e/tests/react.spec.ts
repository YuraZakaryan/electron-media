import { test, expect } from "@playwright/test";

const FIXTURE_URL = "/fixtures/master.m3u8";
const FIXTURE_CUE_TEXT = "Hello from fixture subtitle track";

function harnessUrl(src: string): string {
  return `/react.html?src=${encodeURIComponent(src)}`;
}

test.describe("@electron-media/react useMediaPlayer against a real browser + real hls.js", () => {
  test("plays a real HLS stream and advances currentTime", async ({ page }) => {
    await page.goto(harnessUrl(FIXTURE_URL));

    await expect.poll(
      () => page.locator("#loading-state").textContent(),
      { timeout: 20_000 },
    ).toBe("false");

    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.play());

    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.currentTime),
      { timeout: 15_000 },
    ).toBeGreaterThan(0.5);
  });

  test("renders 2 audio track buttons and clicking one switches selectedAudioTrack in the DOM", async ({ page }) => {
    await page.goto(harnessUrl(FIXTURE_URL));

    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    const languages = await page.locator("#audio-track-list button").evaluateAll(
      (buttons) => buttons.map((button) => (button as HTMLElement).dataset.language),
    );
    expect(languages.sort()).toEqual(["en", "es"]);

    const initiallySelected = await page.locator("#selected-audio-track-id").textContent();

    const otherButtonBeforeClick = page.locator("#audio-track-list button:not(.selected)").first();
    const otherTrackId = await otherButtonBeforeClick.getAttribute("data-track-id");
    // Fix the target button by its track id before clicking — re-querying
    // ":not(.selected)" after the click would resolve to whichever button is
    // NOT selected at that later point, i.e. the one we just clicked away
    // from, not the one we clicked.
    const clickedButton = page.locator(`#audio-track-list button[data-track-id="${otherTrackId}"]`);
    await clickedButton.click();

    await expect.poll(() => page.locator("#selected-audio-track-id").textContent()).toBe(otherTrackId);
    expect(await page.locator("#selected-audio-track-id").textContent()).not.toBe(initiallySelected);

    // The clicked button itself must have gained the "selected" class from
    // re-rendered React state, not merely have fired its onClick handler.
    await expect(clickedButton).toHaveClass(/selected/);
  });

  test("renders the embedded WebVTT subtitle cue text at the right time", async ({ page }) => {
    await page.goto(harnessUrl(FIXTURE_URL));

    await expect.poll(
      () => page.locator("#subtitle-track-list li").count(),
      { timeout: 20_000 },
    ).toBeGreaterThanOrEqual(1);

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

  test("loading an invalid URL surfaces a fatal error in the DOM", async ({ page }) => {
    await page.goto(harnessUrl("/fixtures/does-not-exist.m3u8"));

    await expect.poll(
      () => page.locator("#error-message").textContent(),
      { timeout: 15_000 },
    ).toContain("fatal:true");
  });

  test("the subtitles-off button clears selectedSubtitle and rendered cue text", async ({ page }) => {
    await page.goto(harnessUrl(FIXTURE_URL));

    await expect.poll(
      () => page.locator("#subtitle-track-list li").count(),
      { timeout: 20_000 },
    ).toBeGreaterThanOrEqual(1);

    await page.locator("#subtitle-track-list button").first().click();
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.5;
      return video.play();
    });
    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 15_000 },
    ).toBe(FIXTURE_CUE_TEXT);

    await page.locator("#subtitle-off-button").click();
    await expect.poll(() => page.locator("#selected-subtitle-track-id").textContent()).toBe("");
    await expect.poll(
      () => page.locator("#subtitle-cue-text").textContent(),
      { timeout: 5_000 },
    ).toBe("");
  });

  test("changing sourceUrl after mount tears down the old player and loads the new source", async ({ page }) => {
    // Mount with no source at all — the harness's <video> renders
    // unconditionally either way, satisfying useMediaPlayer's documented
    // non-null-videoRef assumption regardless of when a source arrives.
    await page.goto("/react.html");

    await page.locator("#new-src-input").fill(FIXTURE_URL);
    await page.locator("#load-new-src-button").click();

    // loading-state starts "false" (no source at all yet) regardless of
    // whether the load actually happens, so the track list appearing is
    // the only reliable signal here — not a race-prone poll on the same
    // value the hook starts with.
    await expect.poll(() => page.locator("#audio-track-list li").count(), { timeout: 20_000 }).toBe(2);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.play());
    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.currentTime),
      { timeout: 15_000 },
    ).toBeGreaterThan(0.5);
  });

  test("unmounting the component tears down the player without leaking console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    await page.goto(harnessUrl(FIXTURE_URL));
    await expect.poll(
      () => page.locator("#loading-state").textContent(),
      { timeout: 20_000 },
    ).toBe("false");

    await page.locator("#unmount-button").click();
    await expect.poll(() => page.locator("#mounted-state").textContent()).toBe("false");
    await expect(page.locator("#video")).toHaveCount(0);

    // Give any listener/timer that survived teardown a chance to misfire
    // (e.g. a setState-after-unmount warning, or a repair-loop interval
    // still touching a destroyed video element) before asserting silence.
    await page.waitForTimeout(1_000);
    expect(consoleErrors).toEqual([]);
  });
});
