import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat } from 'mediabunny';
import { drawFrame, FPS, FRAME_COUNT, type Animation } from './render';

const WIDTH = 1920;
const HEIGHT = 1080;
const BITRATE = 5_000_000;

type EncoderKind = 'avc60' | 'avc30' | 'vp9';

export async function exportAnimation(
  animation: Animation,
  onProgress: (frame: number, total: number) => void,
  signal: AbortSignal,
): Promise<{ blob: Blob; extension: string }> {
  const kind = await chooseEncoder();
  const fps = kind === 'avc30' ? 30 : FPS;
  const total = kind === 'avc30' ? Math.round(FRAME_COUNT / 2) : FRAME_COUNT;
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser cannot draw the export canvas');

  const output = new Output({
    format: kind === 'vp9' ? new WebMOutputFormat() : new Mp4OutputFormat(),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, {
    codec: kind === 'vp9' ? 'vp9' : 'avc',
    bitrate: BITRATE,
    fullCodecString: kind === 'avc60' ? 'avc1.64002A' : kind === 'avc30' ? 'avc1.640028' : undefined,
    latencyMode: 'quality',
  });
  output.addVideoTrack(source);
  await output.start();
  try {
    for (let frame = 0; frame < total; frame += 1) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const sourceFrame = Math.round((frame * (FRAME_COUNT - 1)) / Math.max(1, total - 1));
      drawFrame(ctx, animation, sourceFrame);
      await source.add(frame / fps, 1 / fps);
      if (frame % 10 === 0 || frame === total - 1) onProgress(frame + 1, total);
    }
    await output.finalize();
  } catch (error) {
    if (output.state === 'started') await output.cancel();
    throw error;
  }
  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Encoder produced an empty file');
  const extension = kind === 'vp9' ? 'webm' : 'mp4';
  const type = extension === 'mp4' ? 'video/mp4' : 'video/webm';
  return { blob: new Blob([buffer], { type }), extension };
}

async function chooseEncoder(): Promise<EncoderKind> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser cannot encode video. Use a current Chrome, Edge, or Safari.');
  }
  if (await supported('avc1.64002A', 60)) return 'avc60';
  if (await supported('avc1.640028', 30)) return 'avc30';
  if (await supported('vp09.00.10.08', 60)) return 'vp9';
  throw new Error('No H.264 or VP9 encoder is available in this browser.');
}

async function supported(codec: string, framerate: number): Promise<boolean> {
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec,
      width: WIDTH,
      height: HEIGHT,
      bitrate: BITRATE,
      framerate,
    });
    return result.supported === true;
  } catch {
    return false;
  }
}
