import { test, expect } from "@playwright/test";

const FIXTURE_URL = "/fixtures/master.m3u8";

async function bindAndSelectEnglish(page: import("@playwright/test").Page) {
  // bindSubtitleSource is debounced (300ms) before it actually subscribes;
  // StaticSubtitleSource only pushes its cue to whichever listeners are
  // registered AT THE MOMENT selectTrack() runs, so the voice-over
  // subscription must be settled before subtitles are selected — otherwise
  // voice-over's subscription misses the one synchronous emission entirely.
  await page.evaluate(() => (window as any).__bindVoiceOverToStaticSubtitleTrack());
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__selectSubtitleTrack(9999));

  const tracks = await page.evaluate(() => (window as any).__getVoiceOverTracks());
  const en = tracks.find((track: any) => track.language === "en");
  await page.evaluate((trackId) => (window as any).__selectVoiceOverTrack(trackId), en.trackId);
  return en.trackId;
}

test.describe("voice-over against a real browser + real hls.js + fake TTS gateway", () => {
  test("selecting a track and binding to an active subtitle track plays a line and ducks the video volume", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await bindAndSelectEnglish(page);
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.8;
      return video.play();
    });

    // The static cue's window is 2s-3s — the video volume must dip below 1
    // while the (silent) narration line plays, then recover afterward.
    await expect.poll(
      () => page.locator("#voiceover-video-volume").textContent().then(Number),
      { timeout: 10_000 },
    ).toBeLessThan(1);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.pause();
      video.currentTime = 5;
    });
    await expect.poll(
      () => page.locator("#voiceover-video-volume").textContent().then(Number),
      { timeout: 10_000 },
    ).toBe(1);
  });

  test("selectVoiceOverTrack(null) disables narration and clears isGenerating", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await bindAndSelectEnglish(page);
    await page.evaluate(() => (window as any).__selectVoiceOverTrack(null));

    await expect.poll(() => page.locator("#selected-voiceover-track-id").textContent()).toBe("");
    await expect.poll(() => page.locator("#voiceover-is-generating").textContent()).toBe("false");
  });

  test("a forced gateway failure surfaces as a voiceOverLineFailed event", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await page.evaluate(() => (window as any).__setVoiceOverShouldFail(true));
    await bindAndSelectEnglish(page);
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.8;
      return video.play();
    });

    await expect.poll(
      () => page.evaluate(() => (window as any).__voiceOverLineEvents.map((e: any) => e.type)),
      { timeout: 10_000 },
    ).toContain("failed");
  });

  test("unbinding the subtitle source stops feeding new narration cues", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await bindAndSelectEnglish(page);
    await page.evaluate(() => (window as any).__unbindVoiceOverSubtitleTrack());
    // bindSubtitleSource/unbind is debounced (300ms) before it actually
    // takes effect — without waiting it out, the still-active previous
    // binding can start a line before the unbind clears the cue list.
    await page.waitForTimeout(400);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.8;
      return video.play();
    });
    await page.waitForTimeout(1000);

    // No cue source is feeding the scheduler anymore, so it never has
    // anything pending and the video volume must stay untouched.
    expect(await page.locator("#voiceover-is-generating").textContent()).toBe("false");
    expect(await page.locator("#voiceover-video-volume").textContent()).toBe("1");
  });

  test("destroy() with voice-over enabled is idempotent and does not throw", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await bindAndSelectEnglish(page);

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

  test("pausing the video mid-line pauses narration in place — volume stays ducked, does not snap back", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await bindAndSelectEnglish(page);
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.8;
      return video.play();
    });
    await expect.poll(
      () => page.locator("#voiceover-video-volume").textContent().then(Number),
      { timeout: 10_000 },
    ).toBeLessThan(1);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.pause());
    // A hard-stop would restore volume immediately; pause-mirroring must not
    // — the line is only paused, and the video is now paused too, so the
    // ducked volume must persist throughout the pause.
    await page.waitForTimeout(500);
    expect(await page.locator("#voiceover-video-volume").textContent().then(Number)).toBeLessThan(1);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.play());
    await expect.poll(
      () => page.locator("#voiceover-video-volume").textContent().then(Number),
      { timeout: 10_000 },
    ).toBe(1);
  });

  test("original-sound (duck) volume and voice-over volume are independently controllable live", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await bindAndSelectEnglish(page);
    await page.evaluate(() => (window as any).__setVoiceOverDuckVolume(0.4));
    await page.evaluate(() => (window as any).__setVoiceOverVolume(0.6));

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.8;
      return video.play();
    });

    // Only the duck target is observable via video volume — it must settle
    // at the newly configured 0.4, not the old default (0.15) or 1.
    await expect.poll(
      () => page.locator("#voiceover-video-volume").textContent().then(Number),
      { timeout: 10_000 },
    ).toBeCloseTo(0.4, 1);

    // Changing voice-over volume afterward must not perturb the duck level.
    await page.evaluate(() => (window as any).__setVoiceOverVolume(0.9));
    await page.waitForTimeout(300);
    expect(await page.locator("#voiceover-video-volume").textContent().then(Number)).toBeCloseTo(0.4, 1);
  });

  test("Extended Audio Description: pauses the video for a line that doesn't fit its cue window, then resumes it", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await page.evaluate(() => (window as any).__setVoiceOverAllowVideoPause(true));
    await page.evaluate(() => (window as any).__setVoiceOverForceExtendedDuration(true));
    await bindAndSelectEnglish(page);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.8;
      return video.play();
    });

    // The static cue's window is 2s-3s but the forced line duration
    // exceeds it — the video must pause for the line's duration rather
    // than merely duck.
    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.paused),
      { timeout: 10_000 },
    ).toBe(true);

    // ...and resume once the (short, real) narration audio actually ends.
    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.paused),
      { timeout: 10_000 },
    ).toBe(false);
  });

  test("Extended Audio Description: freezes the video right before the NEXT cue's own start, not at this cue's start", async ({ page }) => {
    // Regression test (real browser, real hls.js, real Audio elements) for
    // the reported bug: the video used to freeze the instant an extended
    // line started — well before the next subtitle was ever due — then
    // resume "instantly" right as that next subtitle appeared. cues.vtt's
    // real gap (cue 1: 1s-3s, cue 2 starts 3.5s) is what makes this
    // observable: unlike the single-cue StaticSubtitleSource used by the
    // other Extended AD tests above, there's a genuine next boundary here.
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await page.evaluate(() => (window as any).__setVoiceOverAllowVideoPause(true));
    await page.evaluate(() => (window as any).__setVoiceOverForceExtendedDuration(true));
    await page.evaluate(() => (window as any).__bindVoiceOverToVodExtractedTrack());
    await page.waitForTimeout(400); // bindSubtitleSource debounce

    const tracks = await page.evaluate(() => (window as any).__getVoiceOverTracks());
    const en = tracks.find((track: any) => track.language === "en");
    await page.evaluate((trackId) => (window as any).__selectVoiceOverTrack(trackId), en.trackId);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 0.9;
      return video.play();
    });

    // Cue 1's line starts around currentTime=1 and is forced to run well
    // past its own 2s window (1s-3s) — it must NOT freeze the video right
    // then. Give it a moment to actually start narrating, then confirm the
    // video is still advancing.
    await page.waitForTimeout(600);
    expect(await page.locator("#video").evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
    const midCurrentTime = await page.locator("#video").evaluate((video: HTMLVideoElement) => video.currentTime);
    expect(midCurrentTime).toBeGreaterThan(1); // genuinely still playing, not frozen at cue 1's own start

    // It must still freeze eventually, once real playback closes in on cue
    // 2's own start (3.5s) while the line is still narrating.
    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.paused),
      { timeout: 10_000 },
    ).toBe(true);
    const frozenAt = await page.locator("#video").evaluate((video: HTMLVideoElement) => video.currentTime);
    expect(frozenAt).toBeGreaterThan(3); // close to cue 2's start (3.5s), not cue 1's own start (1s)
    expect(frozenAt).toBeLessThanOrEqual(3.5);

    // ...and resume once the (real, if longer than expected) narration audio ends.
    await expect.poll(
      () => page.locator("#video").evaluate((video: HTMLVideoElement) => video.paused),
      { timeout: 10_000 },
    ).toBe(false);
  });

  test("Extended Audio Description off (default): a too-long line only ducks, never pauses the video", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await page.evaluate(() => (window as any).__setVoiceOverForceExtendedDuration(true));
    await bindAndSelectEnglish(page);

    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.8;
      return video.play();
    });

    await expect.poll(
      () => page.locator("#voiceover-video-volume").textContent().then(Number),
      { timeout: 10_000 },
    ).toBeLessThan(1);
    expect(await page.locator("#video").evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  });

  test("stress: rapid randomized seeks and track switches settle to a consistent final state", async ({ page }) => {
    await page.goto("/core.html");
    await page.evaluate((url) => (window as any).__loadSource(url), FIXTURE_URL);
    await expect.poll(() => page.locator("#ready-state").textContent(), { timeout: 20_000 }).toBe("true");

    await bindAndSelectEnglish(page);
    await page.locator("#video").evaluate((video: HTMLVideoElement) => video.play());

    // Seeded PRNG inline (mirrors the unit-level fuzz test's mulberry32) so
    // this stress run is reproducible across CI runs.
    await page.evaluate(async () => {
      let a = 42;
      const rng = () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const video = document.getElementById("video") as HTMLVideoElement;
      const tracks = await (window as any).__getVoiceOverTracks();
      for (let i = 0; i < 15; i++) {
        const roll = rng();
        if (roll < 0.5) {
          video.currentTime = rng() * 6;
        } else if (roll < 0.8) {
          const track = tracks[Math.floor(rng() * tracks.length)];
          (window as any).__selectVoiceOverTrack(track?.trackId ?? null);
        } else {
          (window as any).__selectVoiceOverTrack(null);
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    });

    // Let everything settle: stop seeking/switching, park outside any cue window.
    await page.locator("#video").evaluate((video: HTMLVideoElement) => {
      video.pause();
      video.currentTime = 6;
    });
    await page.waitForTimeout(1000);

    expect(await page.locator("#voiceover-video-volume").textContent().then(Number)).toBe(1);
    expect(await page.locator("#voiceover-is-generating").textContent()).toBe("false");
    const eventLogLength = await page.evaluate(() => (window as any).__voiceOverLineEvents.length);
    expect(eventLogLength).toBeLessThan(100); // no unbounded growth from the burst

    // No dangling console errors from the randomized interaction burst.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await page.waitForTimeout(200);
    expect(consoleErrors).toEqual([]);
  });
});
