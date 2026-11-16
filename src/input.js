// Injects mouse + keyboard into this PC using Win32 SendInput (via koffi, no native build needed).
const SC = {
  Escape:0x01,Digit1:0x02,Digit2:0x03,Digit3:0x04,Digit4:0x05,Digit5:0x06,Digit6:0x07,Digit7:0x08,Digit8:0x09,Digit9:0x0A,Digit0:0x0B,
  Minus:0x0C,Equal:0x0D,Backspace:0x0E,Tab:0x0F,KeyQ:0x10,KeyW:0x11,KeyE:0x12,KeyR:0x13,KeyT:0x14,KeyY:0x15,KeyU:0x16,KeyI:0x17,KeyO:0x18,KeyP:0x19,
  BracketLeft:0x1A,BracketRight:0x1B,Enter:0x1C,ControlLeft:0x1D,KeyA:0x1E,KeyS:0x1F,KeyD:0x20,KeyF:0x21,KeyG:0x22,KeyH:0x23,KeyJ:0x24,KeyK:0x25,KeyL:0x26,
  Semicolon:0x27,Quote:0x28,Backquote:0x29,ShiftLeft:0x2A,Backslash:0x2B,KeyZ:0x2C,KeyX:0x2D,KeyC:0x2E,KeyV:0x2F,KeyB:0x30,KeyN:0x31,KeyM:0x32,
  Comma:0x33,Period:0x34,Slash:0x35,ShiftRight:0x36,NumpadMultiply:0x37,AltLeft:0x38,Space:0x39,CapsLock:0x3A,
  F1:0x3B,F2:0x3C,F3:0x3D,F4:0x3E,F5:0x3F,F6:0x40,F7:0x41,F8:0x42,F9:0x43,F10:0x44,NumLock:0x45,ScrollLock:0x46,
  Numpad7:0x47,Numpad8:0x48,Numpad9:0x49,NumpadSubtract:0x4A,Numpad4:0x4B,Numpad5:0x4C,Numpad6:0x4D,NumpadAdd:0x4E,
  Numpad1:0x4F,Numpad2:0x50,Numpad3:0x51,Numpad0:0x52,NumpadDecimal:0x53,IntlBackslash:0x56,F11:0x57,F12:0x58,
  // extended keys (0xE0 prefix)
  NumpadEnter:0xE01C,ControlRight:0xE01D,NumpadDivide:0xE035,AltRight:0xE038,Home:0xE047,ArrowUp:0xE048,PageUp:0xE049,
  ArrowLeft:0xE04B,ArrowRight:0xE04D,End:0xE04F,ArrowDown:0xE050,PageDown:0xE051,Insert:0xE052,Delete:0xE053,
  MetaLeft:0xE05B,MetaRight:0xE05C,ContextMenu:0xE05D,PrintScreen:0xE037,
};

const clamp = (v) => Math.min(1, Math.max(0, +v || 0));
let send = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
    const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t', pad: koffi.array('uint8', 8) });
    const INPUT_M = koffi.struct('INPUT_M', { type: 'uint32', mi: MOUSEINPUT });
    const INPUT_K = koffi.struct('INPUT_K', { type: 'uint32', ki: KEYBDINPUT });
    const SendM = user32.func('uint32 __stdcall SendInput(uint32 n, _In_ INPUT_M *p, int cb)');
    const SendK = user32.func('uint32 __stdcall SendInput(uint32 n, _In_ INPUT_K *p, int cb)');
    const CB = 40; // sizeof(INPUT) on x64
    const mouse = (flags, data = 0, dx = 0, dy = 0) =>
      SendM(1, [{ type: 0, mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } }], CB);
    const key = (code, up) => {
      const sc = SC[code];
      if (sc === undefined) return;
      let flags = 0x0008; // KEYEVENTF_SCANCODE
      if (sc > 0xFF) flags |= 0x0001; // extended
      if (up) flags |= 0x0002;
      SendK(1, [{ type: 1, ki: { wVk: 0, wScan: sc & 0xFF, dwFlags: flags, time: 0, dwExtraInfo: 0, pad: [0, 0, 0, 0, 0, 0, 0, 0] } }], CB);
    };
    const BTN = { 0: [0x0002, 0x0004], 1: [0x0020, 0x0040], 2: [0x0008, 0x0010] };
    send = (e) => {
      switch (e.t) {
        case 'mm': mouse(0x0001 | 0x8000, 0, Math.round(clamp(e.x) * 65535), Math.round(clamp(e.y) * 65535)); break;
        case 'md': if (BTN[e.b]) mouse(BTN[e.b][0]); break;
        case 'mu': if (BTN[e.b]) mouse(BTN[e.b][1]); break;
        case 'wh':
          if (e.dy) mouse(0x0800, (-Math.sign(e.dy) * 120) >>> 0);
          if (e.dx) mouse(0x1000, (Math.sign(e.dx) * 120) >>> 0);
          break;
        case 'kd': key(e.code, false); break;
        case 'ku': key(e.code, true); break;
      }
    };
  } catch (err) { console.error('Input injection unavailable:', err.message); }
}

module.exports = {
  inject: (e) => { if (send && e && typeof e === 'object') { try { send(e); } catch (_) {} } },
  available: () => !!send,
};
