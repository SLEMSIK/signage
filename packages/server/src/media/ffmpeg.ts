import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

let available: boolean | null = null;

/** Есть ли ffmpeg/ffprobe. Без них видео загружается, но без превью и автодлительности. */
export async function ffmpegAvailable(): Promise<boolean> {
  if (available !== null) return available;
  try {
    await execFileP(FFPROBE, ['-version'], { timeout: 5000 });
    await execFileP(FFMPEG, ['-version'], { timeout: 5000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

export interface VideoInfo {
  durationSec: number | null;
  codec: string | null;
  width: number | null;
  height: number | null;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  const { stdout } = await execFileP(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', file],
    { timeout: 30_000 },
  );
  const j = JSON.parse(stdout) as {
    streams?: { codec_name?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const s = j.streams?.[0];
  const d = Number(j.format?.duration);
  return {
    durationSec: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) / 1000 : null,
    codec: s?.codec_name ?? null,
    width: s?.width ?? null,
    height: s?.height ?? null,
  };
}

/** Кадр из видео в PNG (буфер). */
export function extractFrame(file: string, atSec: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    const chunks: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length > 0) resolve(buf);
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 500)}`));
    });
  });
}
