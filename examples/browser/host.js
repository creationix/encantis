// A small browser host for an Encantis game.
//
// The game is a wasm module that imports nothing. It exports:
//
//   memory                        its linear memory
//   init(seed)                    start over
//   frame(dt_ms, width, height, buttons, stick_x, stick_y) -> count
//   commands() -> address         where frame() left its `count` commands
//   inbox(), inbox_size(), load(len) -> levels    (optional: an asset)
//
// Each command is 32 bytes, little-endian: op u32, a b c d f32, color u32,
// p u32, n u32. The ops are clear, rect, circle, ring, text and sound (see
// Cmd in lantern.ents). The commands and the text they point at are the
// game's until the next call into it, so they are read right after frame().
//
// readCommands() is the whole contract and runs anywhere; start() wires it
// to a canvas, the keyboard, gamepads and Web Audio.

export const BUTTON = { left: 1, right: 2, up: 4, down: 8, dash: 16, start: 32 }

const KEYS = {
  ArrowLeft: BUTTON.left, KeyA: BUTTON.left,
  ArrowRight: BUTTON.right, KeyD: BUTTON.right,
  ArrowUp: BUTTON.up, KeyW: BUTTON.up,
  ArrowDown: BUTTON.down, KeyS: BUTTON.down,
  Space: BUTTON.dash, KeyX: BUTTON.dash, KeyJ: BUTTON.dash,
  Enter: BUTTON.start,
}

const WAVES = ['sine', 'square', 'triangle', 'sawtooth']
const decoder = new TextDecoder()

// Calls a handler of `on` for each of the `count` commands at `at`.
export function readCommands(memory, at, count, on) {
  const view = new DataView(memory.buffer)
  for (let i = 0; i < count; i++, at += 32) {
    const op = view.getUint32(at, true)
    const a = view.getFloat32(at + 4, true)
    const b = view.getFloat32(at + 8, true)
    const c = view.getFloat32(at + 12, true)
    const d = view.getFloat32(at + 16, true)
    const color = view.getUint32(at + 20, true)
    const p = view.getUint32(at + 24, true)
    const n = view.getUint32(at + 28, true)
    if (op === 1) on.clear(color)
    else if (op === 2) on.rect(a, b, c, d, color)
    else if (op === 3) on.circle(a, b, c, color)
    else if (op === 4) on.ring(a, b, c, d, color)
    else if (op === 5) on.text(a, b, c, d === 1, color, decoder.decode(new Uint8Array(memory.buffer, p, n)))
    else if (op === 6) on.sound(a, b, c, d, WAVES[p] ?? 'sine')
  }
}

// 0xRRGGBBAA as a CSS colour, remembered: a frame uses few.
const colors = new Map()
function css(color) {
  let s = colors.get(color)
  if (!s) {
    s = `rgba(${color >>> 24},${(color >>> 16) & 255},${(color >>> 8) & 255},${(color & 255) / 255})`
    colors.set(color, s)
  }
  return s
}

// Handlers that draw on a 2D canvas context, in CSS pixels.
export function painter(ctx) {
  return {
    clear(color) {
      ctx.fillStyle = css(color)
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    },
    rect(x, y, w, h, color) {
      ctx.fillStyle = css(color)
      ctx.fillRect(x, y, w, h)
    },
    circle(x, y, r, color) {
      ctx.fillStyle = css(color)
      ctx.beginPath()
      ctx.arc(x, y, Math.max(r, 0), 0, 2 * Math.PI)
      ctx.fill()
    },
    ring(x, y, r, width, color) {
      ctx.strokeStyle = css(color)
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.arc(x, y, Math.max(r, 0), 0, 2 * Math.PI)
      ctx.stroke()
    },
    text(x, y, size, centre, color, s) {
      ctx.fillStyle = css(color)
      ctx.font = `${size}px ui-monospace, Menlo, Consolas, monospace`
      ctx.textAlign = centre ? 'center' : 'left'
      ctx.fillText(s, x, y)
    },
    sound() {},
  }
}

// A tone that slides from one pitch to another and fades out. Browsers only
// make sound after a key or a click, so the context starts on the first one.
function synth() {
  let audio = null
  const wake = () => {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') audio.resume()
  }
  addEventListener('keydown', wake)
  addEventListener('pointerdown', wake)
  return (from, to, secs, volume, wave) => {
    if (!audio || audio.state !== 'running' || secs <= 0) return
    const t = audio.currentTime
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = wave
    osc.frequency.setValueAtTime(Math.max(from, 1), t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + secs)
    gain.gain.setValueAtTime(Math.min(Math.max(volume, 0), 1), t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + secs)
    osc.connect(gain).connect(audio.destination)
    osc.start(t)
    osc.stop(t + secs)
  }
}

// The first gamepad's buttons and left stick, in the game's terms.
function gamepad() {
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad) continue
    const down = (i) => pad.buttons[i]?.pressed
    let buttons = 0
    if (down(14)) buttons |= BUTTON.left
    if (down(15)) buttons |= BUTTON.right
    if (down(12)) buttons |= BUTTON.up
    if (down(13)) buttons |= BUTTON.down
    if (down(0) || down(2)) buttons |= BUTTON.dash
    if (down(9)) buttons |= BUTTON.start
    const dead = (v) => (Math.abs(v ?? 0) < 0.2 ? 0 : v)
    return { buttons, x: dead(pad.axes[0]), y: dead(pad.axes[1]) }
  }
  return { buttons: 0, x: 0, y: 0 }
}

// Loads the game, gives it its asset, and runs it on `canvas` until stop().
export async function start({ canvas, wasm, asset, seed = (Math.random() * 2 ** 32) >>> 0 }) {
  const bytes = await (await fetch(wasm)).arrayBuffer()
  const { instance } = await WebAssembly.instantiate(bytes, {})
  const game = instance.exports

  if (asset && game.load) {
    const data = new Uint8Array(await (await fetch(asset)).arrayBuffer())
    const room = game.inbox_size()
    if (data.length > room) console.warn(`${asset}: ${data.length} bytes, the inbox holds ${room}`)
    const len = Math.min(data.length, room)
    new Uint8Array(game.memory.buffer, game.inbox(), len).set(data.subarray(0, len))
    if (game.load(len) === 0) console.warn(`${asset}: no levels in it`)
  }
  game.init(seed)

  let keys = 0
  addEventListener('keydown', (e) => {
    const bit = KEYS[e.code]
    if (!bit) return
    keys |= bit
    e.preventDefault()
  })
  addEventListener('keyup', (e) => {
    keys &= ~(KEYS[e.code] ?? 0)
  })
  addEventListener('blur', () => {
    keys = 0
  })

  // The canvas is as big as the page lays it out, in device pixels, and the
  // game draws in CSS pixels.
  const ctx = canvas.getContext('2d')
  let width = 0
  let height = 0
  const fit = () => {
    const ratio = devicePixelRatio || 1
    width = canvas.clientWidth
    height = canvas.clientHeight
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  }
  new ResizeObserver(fit).observe(canvas)
  fit()

  const on = painter(ctx)
  on.sound = synth()
  let last = performance.now()
  let running = true
  const tick = (now) => {
    if (!running) return
    const pad = gamepad()
    const count = game.frame(now - last, width, height, keys | pad.buttons, pad.x, pad.y)
    last = now
    readCommands(game.memory, game.commands(), count, on)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return {
    game,
    stop() {
      running = false
    },
  }
}
