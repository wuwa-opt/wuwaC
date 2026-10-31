import { filterTagRect, isWideFrame, panelRect, upgradeSearchRect } from './layout.ts';
import { findUpgradeButtonRight } from './pixels.ts';
import {
  createSegmenter,
  gapFillTimes,
  sampleTimes,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  toGray,
  type Segment,
} from './video.ts';

/**
 * Scanner layer, browser side: walk a screen recording with a <video>
 * element, find each settled Echo panel (pure detector in video.ts), and
 * hand one full-resolution frame per panel to the caller as a PNG — so
 * video frames go through exactly the same validation, OCR and review as
 * dropped screenshots.
 *
 * Walking (measured 2026-10-22 on the user's recording in Chromium 155,
 * H.264 with a keyframe every 2 s):
 *   - Seeking costs ~126 ms per sample (each seek decodes from the last
 *     keyframe), so a 12-minute inventory recording would take ~17 min.
 *   - Playback at 4× delivers ~15 frames per video second for ~1/4 of the
 *     wall time, with rare small gaps; at 8× frames drop heavily.
 * So the walk plays at `PLAYBACK_RATE` and samples frames through
 * requestVideoFrameCallback, decimated to ~`VIDEO_SAMPLE_FPS` (the rate
 * the detector's thresholds were measured at). Whenever two samples end up
 * more than `MAX_SAMPLE_GAP` apart — a busy CPU dropping frames, or a
 * hidden tab where callbacks stop — playback pauses and the gap is filled
 * by seeking, so a dropped frame can only cost time, never an Echo.
 * Browsers without requestVideoFrameCallback walk by seeking alone.
 *
 * The OCR frame of each panel is captured during the walk (the sample the
 * segmenter flags), so nothing is seeked twice. It keeps only the panel
 * band, the in-game filter tag (sonata.ts) and, on a wide frame, the
 * strip where the Upgrade button that places the band is; the rest of the frame is
 * painted black (PNG compresses it to nothing, and nothing else on the
 * user's screen enters the scan). Nothing
 * of the recording is stored; the object URL is revoked when done.
 */

/** Longest recording accepted. */
export const MAX_VIDEO_SECONDS = 20 * 60;
/** Samples per second of video (the detector's thresholds were measured at 10). */
export const VIDEO_SAMPLE_FPS = 10;
export const PLAYBACK_RATE = 4;
/** Largest allowed distance between samples (video seconds) before seeking fills the gap. */
export const MAX_SAMPLE_GAP = 0.25;

export interface VideoScanOptions {
  fps?: number;
  signal?: AbortSignal;
  /** Called after each sample with the video time reached. */
  onProgress?: (t: number, duration: number) => void;
  /** One frame per settled panel, in video order. */
  onFrame: (frame: File, segment: Segment) => void;
}

export interface VideoScanResult {
  duration: number;
  segments: number;
}

// HEVC (H.265) is one cause: an HEVC copy of a real recording failed to load in Chromium on Linux (2026-10-30).
const UNPLAYABLE = "This browser can't play that video. If it's HEVC (H.265), save it as MP4 (H.264) or WebM, or use screenshots.";

function aborted(): DOMException {
  return new DOMException('Video scan cancelled', 'AbortError');
}

function once(target: EventTarget, ok: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      target.removeEventListener(ok, onOk);
      target.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOk = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(UNPLAYABLE));
    };
    const onAbort = (): void => {
      cleanup();
      reject(aborted());
    };
    target.addEventListener(ok, onOk);
    target.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);
  });
}

async function seek(video: HTMLVideoElement, t: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const done = once(video, 'seeked', signal);
  video.currentTime = t;
  await done;
}

/** MediaRecorder WebM files report Infinity until the end has been seeked to. */
async function resolveDuration(video: HTMLVideoElement, signal?: AbortSignal): Promise<number> {
  if (Number.isFinite(video.duration)) return video.duration;
  await seek(video, 1e9, signal);
  const duration = video.duration;
  await seek(video, 0, signal);
  return duration;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('No 2D canvas available to read the video.');
  return ctx;
}

/**
 * The Upgrade button's right edge in the frame `video` shows (`panelRect`),
 * looked for only on a wide frame (`isWideFrame`); `ctx` (at least the
 * frame's size) is scratch space.
 */
function locateButton(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number): number | null {
  if (!isWideFrame(width, height)) return null;
  const r = upgradeSearchRect(width, height);
  ctx.drawImage(video, r.left, r.top, r.width, r.height, 0, 0, r.width, r.height);
  const right = findUpgradeButtonRight({ width: r.width, height: r.height, data: ctx.getImageData(0, 0, r.width, r.height).data }, height);
  return right === null ? null : r.left + right;
}

/**
 * Paint the frame `video` shows onto `ctx` (the frame's size) as the
 * scanner's OCR frame: black except the panel band, the filter tag and the
 * Upgrade button's search strip. The band is placed by `button` (on a wide
 * frame), and the strip is kept so the reader places it the same way
 * (pipeline.ts). The walk passes the button it found once, so a capture
 * reads no pixels back: on a slowed phone, a playing video can move to
 * the next panel's frame while the capture is still drawing.
 */
function paintScanFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number, button: number | null): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const strip = button === null ? [] : [upgradeSearchRect(width, height)];
  for (const r of [panelRect(width, height, button), filterTagRect(width, height, button), ...strip]) {
    ctx.drawImage(video, r.left, r.top, r.width, r.height, r.left, r.top, r.width, r.height);
  }
}

/** Times to look for the Upgrade button before the walk: the start, then a few more if the start hides it. */
const BUTTON_PROBES = [0, 0.25, 0.5, 0.75];

function timeLabel(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function whenVisible(signal?: AbortSignal): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      document.removeEventListener('visibilitychange', onChange);
      signal?.removeEventListener('abort', onAbort);
    };
    const onChange = (): void => {
      if (document.hidden) return;
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(aborted());
    };
    document.addEventListener('visibilitychange', onChange);
    signal?.addEventListener('abort', onAbort);
  });
}

type PhaseEnd = { kind: 'ended' } | { kind: 'gap'; to: number } | { kind: 'hidden' };

/**
 * Play from the current position, calling `sample(t)` for frames at least
 * ~one step apart, until the video ends, a gap opens, or the tab hides.
 * Pauses before resolving.
 */
function playPhase(
  video: HTMLVideoElement,
  lastSampled: () => number,
  step: number,
  sample: (t: number) => void,
  signal?: AbortSignal,
): Promise<PhaseEnd> {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = (): void => {
      done = true;
      video.pause();
      video.removeEventListener('ended', onEnded);
      document.removeEventListener('visibilitychange', onVisibility);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (end: PhaseEnd): void => {
      if (done) return;
      cleanup();
      resolve(end);
    };
    const onEnded = (): void => finish({ kind: 'ended' });
    const onVisibility = (): void => {
      if (document.hidden) finish({ kind: 'hidden' });
    };
    const onAbort = (): void => {
      if (done) return;
      cleanup();
      reject(aborted());
    };
    const onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
      if (done) return;
      const t = meta.mediaTime;
      const last = lastSampled();
      if (t - last > MAX_SAMPLE_GAP) {
        finish({ kind: 'gap', to: t });
        return;
      }
      // Decimate to ~the measured sampling rate (playback delivers more).
      if (t >= last + step * 0.9) sample(t);
      video.requestVideoFrameCallback(onVideoFrame);
    };
    video.addEventListener('ended', onEnded);
    document.addEventListener('visibilitychange', onVisibility);
    signal?.addEventListener('abort', onAbort);
    video.playbackRate = PLAYBACK_RATE;
    video.requestVideoFrameCallback(onVideoFrame);
    video.play().catch((err: unknown) => {
      if (done) return;
      cleanup();
      reject(err instanceof Error ? err : new Error(UNPLAYABLE));
    });
  });
}

export async function scanVideo(file: File, options: VideoScanOptions): Promise<VideoScanResult> {
  const { fps = VIDEO_SAMPLE_FPS, signal, onProgress, onFrame } = options;
  const step = 1 / fps;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    const loaded = once(video, 'loadeddata', signal);
    video.src = url;
    await loaded;
    const { videoWidth: width, videoHeight: height } = video;
    if (width === 0 || height === 0) throw new Error(UNPLAYABLE);
    const duration = await resolveDuration(video, signal);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(UNPLAYABLE);
    if (duration > MAX_VIDEO_SECONDS) {
      throw new Error(`That recording is ${Math.round(duration / 60)} minutes long; split it into clips of at most ${MAX_VIDEO_SECONDS / 60} minutes.`);
    }

    const small = document.createElement('canvas');
    small.width = SIGNATURE_WIDTH;
    small.height = SIGNATURE_HEIGHT;
    const smallCtx = context(small);
    const pickCanvas = document.createElement('canvas');
    pickCanvas.width = width;
    pickCanvas.height = height;
    const pickCtx = context(pickCanvas);
    // The detector's band is fixed for the whole recording: on a wide frame
    // it is placed by the first Upgrade button found (the game's layout
    // does not move during a recording; a few seeks at most).
    let button: number | null = null;
    if (isWideFrame(width, height)) {
      for (const at of BUTTON_PROBES) {
        await seek(video, at * duration, signal);
        button = locateButton(pickCtx, video, width, height);
        if (button !== null) break;
      }
    }
    const band = panelRect(width, height, button);

    const segmenter = createSegmenter();
    let segments = 0;
    let lastT = Number.NEGATIVE_INFINITY;
    // Emissions are chained so frames reach the caller in video order.
    let emitted: Promise<void> = Promise.resolve();
    const emit = (segment: Segment): void => {
      segments++;
      // toBlob copies the bitmap synchronously, so the canvas can be redrawn right after.
      const blob = new Promise<Blob | null>((resolve) => pickCanvas.toBlob(resolve, 'image/png'));
      emitted = emitted.then(async () => {
        const png = await blob;
        if (png === null) throw new Error('Could not capture a frame from the video.');
        onFrame(new File([png], `${file.name} @ ${timeLabel(segment.pick)}.png`, { type: 'image/png' }), segment);
      });
    };
    /** The video is showing the frame at `t`: sample it (synchronous). */
    const sample = (t: number): void => {
      smallCtx.drawImage(video, band.left, band.top, band.width, band.height, 0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
      const { data } = smallCtx.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
      const { closed, capture } = segmenter.push(t, toGray(data, SIGNATURE_WIDTH, SIGNATURE_HEIGHT));
      if (closed !== null) emit(closed);
      if (capture) paintScanFrame(pickCtx, video, width, height, button);
      lastT = t;
      onProgress?.(t, duration);
    };
    const seekSample = async (t: number): Promise<void> => {
      await seek(video, t, signal);
      sample(t);
    };

    if (typeof video.requestVideoFrameCallback !== 'function') {
      for (const t of sampleTimes(duration, fps)) await seekSample(t);
    } else {
      await seekSample(0);
      for (;;) {
        await whenVisible(signal);
        const end = await playPhase(video, () => lastT, step, sample, signal);
        if (end.kind === 'gap') {
          for (const t of gapFillTimes(lastT, end.to, step)) await seekSample(t);
          await seekSample(end.to);
        } else if (end.kind === 'ended') {
          // The last frames may have played without a callback.
          for (const t of gapFillTimes(lastT, duration, step)) await seekSample(t);
          break;
        }
        // 'hidden': wait for the tab to come back, then resume (a gap, if any, is repaired).
      }
    }
    const last = segmenter.finish();
    if (last !== null) emit(last);
    await emitted;
    onProgress?.(duration, duration);
    return { duration, segments };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Second frames on demand (Segment.alt), from their own <video> so the walk is never disturbed. */
export interface FrameGrabber {
  /** The scan frame at video time `t` (same masking and naming as the walk's frames). */
  grab: (t: number) => Promise<File>;
  close: () => void;
}

/**
 * Open `file` a second time for re-reads of flagged panels. Each grab is
 * one seek (~0.13 s on the user's H.264 recordings) plus a PNG encode, and
 * only flagged rows ask, so the walk itself pays nothing. Grabs run one at
 * a time on this element.
 */
export async function openFrameGrabber(file: File): Promise<FrameGrabber> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const close = (): void => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };
  try {
    const loaded = once(video, 'loadeddata');
    video.src = url;
    await loaded;
  } catch (err) {
    close();
    throw err;
  }
  const { videoWidth: width, videoHeight: height } = video;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = context(canvas);
  let queue: Promise<unknown> = Promise.resolve();
  const grab = (t: number): Promise<File> => {
    const job = queue.then(async () => {
      await seek(video, t);
      // Paused after a seek, so the button can be looked for in this very frame.
      paintScanFrame(ctx, video, width, height, locateButton(ctx, video, width, height));
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (png === null) throw new Error('Could not capture a frame from the video.');
      return new File([png], `${file.name} @ ${timeLabel(t)}.png`, { type: 'image/png' });
    });
    queue = job.catch(() => undefined);
    return job;
  };
  return { grab, close };
}
