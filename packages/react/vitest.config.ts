import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // renderHook (from @testing-library/react) needs a real DOM to mount
    // into — the hook attaches a MediaPlayer to an actual <video> element.
    environment: "jsdom",
  },
});
