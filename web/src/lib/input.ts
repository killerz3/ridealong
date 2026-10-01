// Mouse, wheel, touch and keyboard on the stage, mapped to the remote page.
import { send } from './conn';
import { get, openModal } from './store';

const BTN = ['left', 'middle', 'right'];
const mods = (e: MouseEvent | KeyboardEvent | WheelEvent) => ({ alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });

export function bindInput(stage: HTMLElement, canvas: HTMLCanvasElement, kbd: HTMLTextAreaElement, focusAddress: () => void) {
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect(), f = get().frame!;
    return { x: (e.clientX - r.left) / r.width * f.w, y: (e.clientY - r.top) / r.height * f.h };
  };
  const ready = () => !!get().frame && !!get().tab;
  let clicks = 0, lastDown = 0;
  let moveQueued: Parameters<typeof send>[0] | null = null;
  let wheelQ: { t: 'mouse'; type: string; x: number; y: number; dx: number; dy: number } | null = null;

  const down = (e: MouseEvent) => {
    if (!ready()) return;
    e.preventDefault(); stage.focus();
    clicks = Date.now() - lastDown < 400 ? clicks + 1 : 1; lastDown = Date.now();
    send({ t: 'mouse', type: 'mousePressed', ...pos(e), button: BTN[e.button], buttons: e.buttons, clickCount: clicks, ...mods(e) });
  };
  const up = (e: MouseEvent) => {
    if (!ready() || e.target !== canvas) return;
    send({ t: 'mouse', type: 'mouseReleased', ...pos(e), button: BTN[e.button], buttons: e.buttons, clickCount: clicks, ...mods(e) });
  };
  const move = (e: MouseEvent) => {
    if (!ready()) return;
    const m = { t: 'mouse' as const, type: 'mouseMoved', ...pos(e), button: e.buttons & 1 ? 'left' : 'none', buttons: e.buttons, ...mods(e) };
    if (!moveQueued) requestAnimationFrame(() => { if (moveQueued) send(moveQueued); moveQueued = null; });
    moveQueued = m;
  };
  const wheel = (e: WheelEvent) => {
    if (!ready()) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    if (wheelQ) { wheelQ.dx += e.deltaX * k; wheelQ.dy += e.deltaY * k; return; }
    wheelQ = { t: 'mouse', type: 'mouseWheel', ...pos(e), dx: e.deltaX * k, dy: e.deltaY * k, ...mods(e) };
    requestAnimationFrame(() => { if (wheelQ) send(wheelQ); wheelQ = null; });
  };
  const menu = (e: Event) => e.preventDefault();

  // touch: tap = click, drag = scroll
  let touch: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
  const tStart = (e: TouchEvent) => {
    if (!ready() || e.touches.length !== 1) return;
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, moved: false };
  };
  const tMove = (e: TouchEvent) => {
    if (!touch || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0], r = canvas.getBoundingClientRect(), k = get().frame!.w / r.width;
    if (Math.hypot(t.clientX - touch.sx, t.clientY - touch.sy) > 8) touch.moved = true;
    if (touch.moved) send({ t: 'mouse', type: 'mouseWheel', ...pos(t), dx: (touch.x - t.clientX) * k, dy: (touch.y - t.clientY) * k });
    touch.x = t.clientX; touch.y = t.clientY;
  };
  const tEnd = (e: TouchEvent) => {
    if (!touch) return;
    if (!touch.moved) {
      e.preventDefault();
      const p = pos({ clientX: touch.sx, clientY: touch.sy });
      send({ t: 'mouse', type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
      send({ t: 'mouse', type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
    }
    touch = null;
  };

  // on-screen keyboard (phones): a hidden textarea that forwards what you type
  const kInput = (e: Event) => {
    const ie = e as InputEvent;
    if (ie.inputType === 'deleteContentBackward') {
      send({ t: 'key', type: 'keyDown', key: 'Backspace', code: 'Backspace', keyCode: 8 });
      send({ t: 'key', type: 'keyUp', key: 'Backspace', code: 'Backspace', keyCode: 8 });
    } else if (ie.data) send({ t: 'text', text: ie.data });
    kbd.value = ' ';
  };
  const kKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    send({ t: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13 });
    send({ t: 'key', type: 'keyUp', key: 'Enter', code: 'Enter', keyCode: 13 });
  };

  const keyDown = (e: KeyboardEvent) => {
    if (e.target === kbd || !get().tab) return;
    const k = e.key.toLowerCase(), cmd = e.ctrlKey || e.metaKey;
    if (cmd && k === 'v') return; // the paste event carries the text
    if (cmd && k === 'l') { e.preventDefault(); return focusAddress(); }
    if (cmd && k === 'k') { e.preventDefault(); return openModal('palette'); }
    e.preventDefault();
    send({ t: 'key', type: 'keyDown', key: e.key, code: e.code, keyCode: e.keyCode, ...mods(e) });
  };
  const keyUp = (e: KeyboardEvent) => {
    if (e.target === kbd || !get().tab) return;
    e.preventDefault();
    send({ t: 'key', type: 'keyUp', key: e.key, code: e.code, keyCode: e.keyCode, ...mods(e) });
  };
  const paste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text');
    if (text) { e.preventDefault(); send({ t: 'text', text }); }
  };

  canvas.addEventListener('mousedown', down);
  window.addEventListener('mouseup', up);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', menu);
  canvas.addEventListener('touchstart', tStart, { passive: true });
  canvas.addEventListener('touchmove', tMove, { passive: false });
  canvas.addEventListener('touchend', tEnd);
  kbd.addEventListener('input', kInput);
  kbd.addEventListener('keydown', kKey);
  stage.addEventListener('keydown', keyDown);
  stage.addEventListener('keyup', keyUp);
  stage.addEventListener('paste', paste);
  return () => {
    canvas.removeEventListener('mousedown', down);
    window.removeEventListener('mouseup', up);
    canvas.removeEventListener('mousemove', move);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('contextmenu', menu);
    canvas.removeEventListener('touchstart', tStart);
    canvas.removeEventListener('touchmove', tMove);
    canvas.removeEventListener('touchend', tEnd);
    kbd.removeEventListener('input', kInput);
    kbd.removeEventListener('keydown', kKey);
    stage.removeEventListener('keydown', keyDown);
    stage.removeEventListener('keyup', keyUp);
    stage.removeEventListener('paste', paste);
  };
}
