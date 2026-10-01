// Video mode: capture the workspace's virtual display with ffmpeg and stream
// H.264 (Annex B, one access unit per message) for WebCodecs in the browser.
// Only runs while a viewer is watching in video mode.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { which } from './chrome.js';

const AUD = Buffer.from([0, 0, 0, 1, 9]);
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

function isKey(au: Buffer) {
  for (let i = 0; i + 4 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      const t = au[i + 3] & 0x1f;
      if (t === 5 || t === 7) return true;
      i += 2;
    }
  }
  return false;
}

let support: boolean | undefined;
// ffmpeg with x11grab and libx264, checked once
export function videoSupported() {
  if (support === undefined) {
    support = false;
    if (which('ffmpeg')) {
      const enc = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
      const dev = spawnSync('ffmpeg', ['-hide_banner', '-devices'], { encoding: 'utf8' }).stdout || '';
      support = /libx264/.test(enc) && /x11grab/.test(dev);
    }
  }
  return support;
}

interface Rect { x: number; y: number; w: number; h: number }

export class VideoCapture extends EventEmitter {
  size = { w: 0, h: 0 };
  private proc?: ChildProcess;
  private stopped = false;

  // crop: region of the display holding the page; out: encoded size
  constructor(private opts: { display: string; crop: Rect; out: { w: number; h: number }; fps: number }) { super(); }

  start() {
    const { display, crop, out, fps } = this.opts;
    const cw = even(crop.w), ch = even(crop.h);
    const ow = even(Math.min(out.w, cw)), oh = even(Math.min(out.h, ch));
    this.size = { w: ow, h: oh };
    const args = [
      '-loglevel', 'error', '-nostdin',
      '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), '-video_size', `${cw}x${ch}`,
      '-i', `${display}+${crop.x},${crop.y}`,
      ...(ow !== cw || oh !== ch ? ['-vf', `scale=${ow}:${oh}:flags=fast_bilinear`] : []),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline',
      '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-bf', '0', '-crf', '27', '-maxrate', '6M', '-bufsize', '2M',
      '-x264-params', 'repeat-headers=1:sliced-threads=1', '-threads', '2',
      '-bsf:v', 'h264_metadata=aud=insert', '-flush_packets', '1', '-f', 'h264', 'pipe:1',
    ];
    const p = this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr!.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', (e: NodeJS.ErrnoException) => this.emit('error', e.code === 'ENOENT' ? new Error('ffmpeg is not installed') : e));
    p.on('exit', code => { if (!this.stopped) this.emit('error', new Error(`ffmpeg exited (${code}): ${err.trim()}`)); });

    let buf: Buffer = Buffer.alloc(0);
    let flushTimer: NodeJS.Timeout | undefined;
    const emit = (au: Buffer) => au.length && this.emit('frame', au, isKey(au));
    // each access unit starts with an AUD; a short quiet gap also ends one
    p.stdout!.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      let i;
      while ((i = buf.indexOf(AUD, 1)) > 0) { emit(buf.subarray(0, i)); buf = buf.subarray(i); }
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { emit(buf); buf = Buffer.alloc(0); }, 3);
    });
    return this;
  }

  stop() {
    this.stopped = true;
    this.proc?.kill('SIGKILL');
  }
}
