#!/usr/bin/env node
// Generates a small local HLS fixture (video + 2 audio renditions + 1
// WebVTT subtitle rendition) used by the Playwright E2E suite. Regenerable
// and idempotent — safe to delete e2e/.generated and rerun.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, ".generated", "stream");

const DURATION_SECONDS = 8;
const SEGMENT_SECONDS = 2;
const FRAME_RATE = 30;
// GOP length must equal segment length in frames or hls.js sees a keyframe
// straddling a segment boundary and fragments the level differently than
// the playlist declares.
const GOP_FRAMES = SEGMENT_SECONDS * FRAME_RATE;

const CUES_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hello from fixture subtitle track

2
00:00:03.500 --> 00:00:05.500
Second fixture subtitle cue

3
00:00:05.500 --> 00:00:07.500
Third fixture subtitle cue
`;

function buildSubtitlePlaylist() {
  return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${DURATION_SECONDS}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:${DURATION_SECONDS}.000,
cues.vtt
#EXT-X-ENDLIST
`;
}

/**
 * ffmpeg's HLS muxer (mpegts/fmp4 segmenters) cannot mux a WebVTT stream at
 * all on this build — confirmed by reproducing "No streams to mux were
 * specified" even for a subtitle-only, video-less invocation. Real-world VOD
 * packagers commonly ship a subtitle rendition as one WebVTT-media-playlist
 * pointing at a single .vtt segment spanning the whole asset; hls.js
 * supports exactly that shape, so we hand-author it instead of fighting
 * ffmpeg's subtitle muxing bug.
 */
function injectSubtitleRendition(masterPlaylistText) {
  const subtitleMediaLine =
    `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",` +
    `LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subs.m3u8"\n`;

  const lines = masterPlaylistText.split("\n");
  const output = [];
  let injectedMedia = false;

  for (const line of lines) {
    if (!injectedMedia && line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      output.push(line);
      continue;
    }
    if (!injectedMedia && line.startsWith("#EXT-X-STREAM-INF")) {
      output.push(subtitleMediaLine.trimEnd());
      injectedMedia = true;
    }
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      output.push(line.trimEnd() + `,SUBTITLES="subs"`);
      continue;
    }
    output.push(line);
  }

  return output.join("\n");
}

function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  writeFileSync(join(OUT_DIR, "cues.vtt"), CUES_VTT);
  writeFileSync(join(OUT_DIR, "subs.m3u8"), buildSubtitlePlaylist());

  const varStreamMap = [
    "v:0,agroup:aud,name:video",
    "a:0,agroup:aud,language:en,name:AudioEn,default:yes",
    "a:1,agroup:aud,language:es,name:AudioEs",
  ].join(" ");

  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi", "-i", `testsrc=size=640x360:rate=${FRAME_RATE}:duration=${DURATION_SECONDS}`,
      // Two distinct frequencies so the two audio renditions are
      // trivially distinguishable by ear/analysis, not just by label.
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION_SECONDS}`,
      "-f", "lavfi", "-i", `sine=frequency=880:duration=${DURATION_SECONDS}`,
      "-map", "0:v", "-map", "1:a", "-map", "2:a",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      // Baseline profile + explicit level: the widest-compatibility decode
      // path, avoiding any chance of a profile hls.js/Chromium's video
      // decoder rejects.
      "-profile:v", "baseline",
      "-level", "3.0",
      "-preset", "veryfast",
      // Keyframe exactly every SEGMENT_SECONDS and never scene-cut-triggered
      // early, so every HLS segment starts on a keyframe as the playlist
      // promises (required for hls.js's segment-level seeking/appends).
      "-g", String(GOP_FRAMES),
      "-keyint_min", String(GOP_FRAMES),
      "-sc_threshold", "0",
      "-c:a", "aac",
      "-b:a", "64k",
      "-var_stream_map", varStreamMap,
      "-master_pl_name", "master.m3u8",
      "-hls_time", String(SEGMENT_SECONDS),
      "-hls_list_size", "0",
      "-hls_playlist_type", "vod",
      "-hls_flags", "independent_segments",
      "-f", "hls",
      "stream_%v.m3u8",
    ],
    { cwd: OUT_DIR, stdio: ["ignore", "ignore", "pipe"] },
  );

  const masterPath = join(OUT_DIR, "master.m3u8");
  const original = readFileSync(masterPath, "utf8");
  writeFileSync(masterPath, injectSubtitleRendition(original));

  console.log(`[generate-stream] wrote fixture HLS stream to ${OUT_DIR}`);
}

try {
  main();
} catch (error) {
  if (error?.stderr) {
    process.stderr.write(error.stderr.toString());
  }
  console.error("[generate-stream] failed:", error?.message ?? error);
  process.exit(1);
}
