# Detecting static-image "videos" before downloading

Real problem, reported directly by a user after watching a batch of downloaded music videos: some officially-tagged, correctly-matched "Official Video" uploads are just a still photo the whole way through — sometimes with a slow pan/zoom applied (the "Ken Burns effect"), which isn't detectable by title/metadata matching at all, since the title and channel are completely legitimate. This is a content problem, not a search-matching problem.

## What doesn't work: `freezedetect`

ffmpeg's `freezedetect` filter (frame-difference based) was the first thing tried. It **misses slow pans/zooms** — a video that's technically a still photo but has continuous slow camera movement applied isn't frame-identical, so freezedetect doesn't flag it. Confirmed on a real, user-reported case: freezedetect found only ~7 seconds of "frozen" content out of a ~275-second video that's a static photo for its entire length.

## What works: scene-change counting

Real produced music videos have frequent cuts — dozens to hundreds over a few minutes. A static photo (panned or not) never has a real scene change, because there's only ever one "scene." This is a much stronger, more robust signal:

```bash
ffmpeg -i input.mkv -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep -c Parsed_showinfo
```

## Two ways to apply it — and why the second one won

**First attempt: download a ~20s sample, run scene-detect on it.** Worked (`hasMotion()`'s first version) — validated against real files:

| Video | Scene changes | Verdict |
|---|---|---|
| Known-good real MV, full length (~210s) | 184 | real video |
| Known-good real MV, 20s sample only | 28 | real video |
| Confirmed-static, full length (~275s) | 2 | static |

But it has two real costs: several MB downloaded per candidate checked, and it only sees *one slice* of the timeline — a real video with a long intro (spoken word, logo card) could land the sample on a slow segment and get wrongly rejected.

**What it was replaced with: YouTube's own storyboard sprite images** — the small tile images YouTube already generates for the seek-bar hover preview (`yt-dlp -f sb1`). These are embedded in an `.mhtml` container as raw binary image/webp parts (no base64 — extract using each part's declared `Content-length` header directly). Sliced into individual ~90×90px tiles and stitched into a synthetic 1fps sequence, the *same* scene-change counter runs on that instead:

| Video | Total size fetched | Scene changes (full timeline) | Verdict |
|---|---|---|---|
| Known-good real MV | ~175KB | 34 (across 198 tiles) | real video |
| Confirmed-static #1 | ~40KB | 2 (across 35 tiles) | static |
| Confirmed-static #2 | ~53KB | 2 | static |

Same clean separation, **tens of KB instead of several MB, and covers the video's entire duration** rather than one sampled slice — strictly better on both cost and reliability. No part of the actual video is ever downloaded just to run this check.

Threshold used: `MOTION_CHECK_SCENE_THRESHOLD = 5` in `src/services/youtube.js` — both known examples clear it by 6x+ margin (34 vs 5), so there's real headroom before this needs tuning.

## Where this lives in the code

`src/services/youtube.js`:
- `hasMotion(videoId)` — fetches the storyboard, extracts/slices/stitches, runs the scene-change count, returns true/false. Fails open (returns true) if no storyboard is available for a given video, e.g. some livestreams/restricted content — don't block a candidate on a check that couldn't actually run.
- `findCandidate()` ranks *all* plausible candidates per tier (not just the top one) and walks them best-first via `pickFirstWithMotion()`, rejecting any that fail the motion check and trying the next, falling through tiers (high → medium → live) rather than giving up on the first static hit.

This runs **before** any full download happens — the goal (per direct user request) was catching this at candidate-selection time, not as an after-the-fact cleanup pass on already-downloaded files.
