# Detecting static-image "videos" before downloading

Real problem, reported directly by a user after watching a batch of downloaded music videos: some officially-tagged, correctly-matched "Official Video" uploads are just a still photo the whole way through — sometimes with a slow pan/zoom applied (the "Ken Burns effect"), which isn't detectable by title/metadata matching at all, since the title and channel are completely legitimate. This is a content problem, not a search-matching problem.

## What doesn't work: `freezedetect`

ffmpeg's `freezedetect` filter (frame-difference based) was the first thing tried. It **misses slow pans/zooms** — a video that's technically a still photo but has continuous slow camera movement applied isn't frame-identical, so freezedetect doesn't flag it. Confirmed on a real, user-reported case: freezedetect found only ~7 seconds of "frozen" content out of a ~275-second video that's a static photo for its entire length.

## What works: scene-change counting

Real produced music videos have frequent cuts — dozens to hundreds over a few minutes. A static photo (panned or not) never has a real scene change, because there's only ever one "scene." This is a much stronger, more robust signal:

```bash
ffmpeg -i input.mkv -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep -c Parsed_showinfo
```

Validated against real files:
| Video | Scene changes | Verdict |
|---|---|---|
| Known-good real MV (full length, ~210s) | 184 | real video |
| Known-good real MV (20s sample only) | 28 | real video |
| Confirmed-static, user-reported (full length, ~275s) | 2 | static |
| Confirmed-static, user-reported (full length, ~269s) | 2 | static |

The gap is large enough (single digits vs. dozens+) that a threshold of "5 scene changes in a 20-second sample" cleanly separates real videos from static ones, even from a short sample rather than the full file.

## Where this lives in the code

`src/services/youtube.js`:
- `hasMotion(videoId, durationSec)` — downloads a short (~20s) low-quality sample from ~30% into the video (`yt-dlp --download-sections`), runs the scene-change count above, returns true/false. Costs a few seconds and a few MB, not a full download.
- `findCandidate()` now ranks *all* plausible candidates per tier (not just the top one) and walks them best-first via `pickFirstWithMotion()`, rejecting any that fail the motion check and trying the next, falling through tiers (high → medium → live) rather than giving up on the first static hit.

This runs **before** any full download happens - the goal (per direct user request) was catching this at candidate-selection time, not as an after-the-fact cleanup pass on already-downloaded files.
