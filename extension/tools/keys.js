// Key table for the `computer` tool's `key` action.
//
// CDP Input.dispatchKeyEvent needs a real `windowsVirtualKeyCode`, a `code`,
// and `text` for keys that produce a character. Without them Enter does not
// submit forms (the page sees keyCode 69 and no "\r"). Table values mirror the
// official extension's.

const SPECIAL = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  kp_enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r", isKeypad: true },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  del: { key: "Delete", code: "Delete", keyCode: 46 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  capslock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  pause: { key: "Pause", code: "Pause", keyCode: 19 },
  printscreen: { key: "PrintScreen", code: "PrintScreen", keyCode: 44 },
  ";": { key: ";", code: "Semicolon", keyCode: 186, text: ";" },
  "=": { key: "=", code: "Equal", keyCode: 187, text: "=" },
  ",": { key: ",", code: "Comma", keyCode: 188, text: "," },
  "-": { key: "-", code: "Minus", keyCode: 189, text: "-" },
  ".": { key: ".", code: "Period", keyCode: 190, text: "." },
  "/": { key: "/", code: "Slash", keyCode: 191, text: "/" },
  "`": { key: "`", code: "Backquote", keyCode: 192, text: "`" },
  "[": { key: "[", code: "BracketLeft", keyCode: 219, text: "[" },
  "\\": { key: "\\", code: "Backslash", keyCode: 220, text: "\\" },
  "]": { key: "]", code: "BracketRight", keyCode: 221, text: "]" },
  "'": { key: "'", code: "Quote", keyCode: 222, text: "'" },
};

for (let n = 1; n <= 12; n++) SPECIAL[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
for (let n = 0; n <= 9; n++) {
  SPECIAL[`numpad${n}`] = { key: String(n), code: `Numpad${n}`, keyCode: 96 + n, isKeypad: true };
}
const PAD = { multiply: ["*", 106], add: ["+", 107], subtract: ["-", 109], decimal: [".", 110], divide: ["/", 111] };
for (const [name, [key, keyCode]] of Object.entries(PAD)) {
  SPECIAL[`numpad${name}`] = { key, code: `Numpad${name[0].toUpperCase()}${name.slice(1)}`, keyCode, isKeypad: true };
}

// Shifted symbols: the character, the physical key that produces it.
const SHIFTED = {
  "!": ["Digit1", 49], "@": ["Digit2", 50], "#": ["Digit3", 51], $: ["Digit4", 52], "%": ["Digit5", 53],
  "^": ["Digit6", 54], "&": ["Digit7", 55], "*": ["Digit8", 56], "(": ["Digit9", 57], ")": ["Digit0", 48],
  _: ["Minus", 189], "+": ["Equal", 187], "{": ["BracketLeft", 219], "}": ["BracketRight", 221],
  "|": ["Backslash", 220], ":": ["Semicolon", 186], '"': ["Quote", 222], "<": ["Comma", 188],
  ">": ["Period", 190], "?": ["Slash", 191], "~": ["Backquote", 192],
};

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const MOD_NAMES = {
  ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift",
  meta: "meta", cmd: "meta", command: "meta", win: "meta", windows: "meta", super: "meta",
};

// Editing commands CDP needs for macOS-style shortcuts (they have no effect
// from a bare key event). Only attached when the meta key is held.
const META_COMMANDS = {
  a: ["selectAll"], c: ["copy"], x: ["cut"], v: ["paste"], z: ["undo"], "shift+z": ["redo"],
};

/** Descriptor for one key name (no modifiers), or null if it isn't a key. */
export function resolveKey(name, shift = false) {
  if (typeof name !== "string" || name === "") return null;
  const lower = name.toLowerCase();
  if (SPECIAL[lower]) return { ...SPECIAL[lower] };
  if (name.length === 1) {
    if (SHIFTED[name]) {
      const [code, keyCode] = SHIFTED[name];
      return { key: name, code, keyCode, text: name };
    }
    if (/[a-z]/i.test(name)) {
      const up = name.toUpperCase();
      const k = shift || name !== lower ? up : lower;
      return { key: k, code: `Key${up}`, keyCode: up.charCodeAt(0), text: k };
    }
    if (/[0-9]/.test(name)) {
      return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
    }
  }
  return null;
}

/**
 * Parse "ctrl+shift+a", "Enter", "cmd+a" into { modifiers, desc, commands }.
 * Returns null when the final key is unknown.
 */
export function parseKeyCombo(combo) {
  const parts = String(combo).split("+");
  // "ctrl++" / "+" : an empty trailing part means the key itself is "+".
  const mods = new Set();
  let keyName = "";
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i].trim();
    if (raw === "" && i === parts.length - 1 && i > 0) { keyName = "+"; continue; }
    if (raw === "" && parts.length === 1) return null;
    const m = MOD_NAMES[raw.toLowerCase()];
    if (m && i < parts.length - 1) mods.add(m);
    else keyName = raw;
  }
  let modifiers = 0;
  for (const m of mods) modifiers |= MOD[m];
  const desc = resolveKey(keyName, mods.has("shift"));
  if (!desc) return null;
  // Keys that produce text must not when ctrl/alt/meta is held (ctrl+a must not type "a").
  if (modifiers & (MOD.ctrl | MOD.alt | MOD.meta)) delete desc.text;
  let commands;
  if (mods.has("meta")) {
    const k = (mods.has("shift") ? "shift+" : "") + keyName.toLowerCase();
    if (META_COMMANDS[k]) commands = META_COMMANDS[k];
  }
  return { modifiers, desc, commands };
}

/** The two Input.dispatchKeyEvent param objects for a combo, or null. */
export function buildKeyEvents(combo) {
  const p = parseKeyCombo(combo);
  if (!p) return null;
  const { desc, modifiers, commands } = p;
  const base = {
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.keyCode,
    nativeVirtualKeyCode: desc.keyCode,
    modifiers,
  };
  if (desc.isKeypad) base.isKeypad = true;
  const down = {
    ...base,
    type: desc.text ? "keyDown" : "rawKeyDown",
    ...(desc.text ? { text: desc.text, unmodifiedText: desc.text } : {}),
    ...(commands ? { commands } : {}),
  };
  return { down, up: { ...base, type: "keyUp" } };
}
