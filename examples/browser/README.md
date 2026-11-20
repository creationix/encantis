# Browser games

A complete small game and a starter template, run by one small host.

| File | What it is |
| --- | --- |
| [`lantern.ents`](lantern.ents) | **Lantern**, an arena game: collect the sparks, dash through the wisps. Animation, keyboard, gamepad and touch input, sound, any canvas size, and five levels written as data. |
| [`starter.ents`](starter.ents) | The smallest game on the same contract: a dot to steer to a target. Copy it to start your own. |
| [`host.js`](host.js) | The host: loads a game, feeds it input (keys, gamepads, touch) and plays the commands it leaves in memory on a canvas and through Web Audio. |
| [`index.html`](index.html) | The page. `?game=starter` runs the template. |
| [`build.ts`](build.ts) | Builds both into `dist/` and reports what each part weighs. |
| [`game.test.ts`](game.test.ts) | The games as a host sees them, over many frames. |

## Run it

```bash
bun examples/browser/build.ts
```

```bash
python3 -m http.server --directory examples/browser/dist 8000
```

Then open <http://localhost:8000>. Arrows or WASD move, space dashes, enter starts; on a gamepad, the left stick or the d-pad moves, A dashes, Start starts; on a touch screen, a tap starts, dragging a finger steers (from where it went down), and a second finger dashes.

Or play it at <https://creationix.github.io/encantis/lantern/>: the [Pages workflow](../../.github/workflows/pages.yml) builds the same `dist/` on each push to `main` and publishes it at `lantern/` on the repository's Pages site, beside the rendered README and docs. Pages runs it once its source is "GitHub Actions" (Settings → Pages).

## What it weighs

`build.ts` compiles each game with `encantis wasm --release`, minifies `host.js`, and measures every file apart (bytes, then gzip -9 and brotli -11):

| File | Bytes | gzip | brotli |
| --- | ---: | ---: | ---: |
| `lantern.wasm` | 7008 | 3397 | 3165 |
| `starter.wasm` | 966 | 586 | 551 |
| `host.js` (minified) | 3819 | 1813 | 1623 |
| `index.html` | 675 | 442 | 293 |
| **Lantern, its three files** | **11502** | **5652** | **5081** |
| **starter, its three files** | **5460** | **2841** | **2467** |

Memory: one 64 KiB page, fixed. Lantern's data (its pools, the command list, its levels and its strings) reaches byte 37173 of it, and after an hour of play (216,000 frames, starting over each time the game ends) the memory is still that one page: the module has no `memory.grow`. The busiest frame asks for 167 of its 1024 commands.

The numbers come from `dist/sizes.json`, which the build writes; run it again after a change. Both games' release builds are also held to size budgets in `scripts/size-budgets.json`, so `bun test` (and CI) fails when one grows past its budget; `bun run size --update` sets new ones when the growth is meant.

## The contract

A game is a wasm module that **imports nothing**. The host calls it; it never calls the host. So it runs the same in a page, in a test, or in any other host, and the same seed and input give the same frames.

| Export | |
| --- | --- |
| `memory` | Its linear memory, one page, which never grows. |
| `init(seed: u32)` | Sets the game up with this seed: Lantern at its title screen, the starter playing. The host calls it before the first frame (Lantern traps without it), and calls it again to start over: a game started over plays as one just loaded and started with the same seed, keeping only Lantern's best score. |
| `frame(dt_ms: f32, width: f32, height: f32, buttons: u32, stick_x: f32, stick_y: f32) -> u32` | Plays one frame and gives the number of commands it wrote. `dt_ms` counts up to 50 (an infinite one as 50), and one that is NaN or negative counts as none; the size is the canvas in CSS pixels; the stick is in [-1, 1], and a value outside it (NaN or infinite too) counts as 0. |
| `commands() -> u32` | The address of the first command. |

Buttons are bits: left 1, right 2, up 4, down 8, dash 16, start 32.

Each command is 32 bytes, little-endian, one after another:

| Bytes | 0 | 4 | 8 | 12 | 16 | 20 | 24 | 28 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Field | `op: u32` | `a: f32` | `b: f32` | `c: f32` | `d: f32` | `color: u32` | `p: u32` | `n: u32` |

| `op` | Means |
| --- | --- |
| 1 clear | The whole canvas in `color` (0xRRGGBBAA). |
| 2 rect | A rectangle at (`a`, `b`), `c` wide and `d` high. |
| 3 circle | A disc at (`a`, `b`) of radius `c`. |
| 4 ring | A circle's outline: centre (`a`, `b`), radius `c`, line width `d`. |
| 5 text | `n` bytes of UTF-8 at address `p`, `c` pixels high, with its baseline at `b`, starting at `a`, or centred on `a` when `d` is 1. |
| 6 sound | A tone from `a` Hz to `b` Hz over `c` seconds at volume `d`; `p` is the wave (0 sine, 1 square, 2 triangle, 3 sawtooth). |

What crosses the boundary, and for how long:

- **The commands and their text belong to the game.** They are valid from the return of `frame()` until the next call into the module, so the host reads them right away (`readCommands` in `host.js`). Text a frame makes, like a score's digits, is in a per-frame arena that the next `frame()` starts over; constant text is in the data section and never moves.
- **Nothing is re-entered.** With no imports, no call into the module can call back out, so each call runs to its end before the next starts. Instances share nothing: several games on one page, or in one test, don't see each other.
- **Layout is the language's**, byte-packed with no padding ([reference 9.6](../../docs/encantis.md#96-structs-and-slices-in-memory)), so `Cmd` is the 32 bytes above at a stride of 32, and a struct's fields are where its declaration says.
- **Slices and several results** don't cross as such: the text of a command is a slice given as its two values, `p` and `n`, and `frame` returns one number while the rest stays in memory. A wasm export can return several values (JavaScript gets an array), but one call per frame and one read of memory is cheaper and works in every host.

## Without allocating

Nothing in Lantern allocates after it starts: it has no heap. Each kind of thing has a fixed pool, laid out in one struct in memory, and each pool says what happens when it is full:

| Pool | Size | When it is full |
| --- | ---: | --- |
| `world.wisps` | 32 | No more wisps come out of the dark. |
| `world.sparks` | 3 | More wait until one is collected. |
| `world.motes` (particles) | 96 | A new one replaces the oldest (a ring). |
| `cmds.list` | 1024 | Commands past the last are dropped; the frame still ends. |
| `scratch` (per-frame text) | 256 bytes | Text that doesn't fit is left out. |

The pools are arrays inside structs, indexed where they lie: `world.wisps[i]` with `i` from `for i in max-wisps` is proven in range and is one address computation, and `&cmds.list[cmds.count]` is the next free command or none when the list is full ([reference: Fixed Arrays in Place](../../docs/encantis.md#fixed-arrays-in-place)).

The levels are not loaded or parsed: they are `data`, laid out when the module is compiled. Each is a start position and a table of 14 rows written as strings, `rows: *[14][24]u8`, read as `m.rows[y][x] == '#'`. A row is a pointer to its bytes ([reference: Nesting](../../docs/encantis.md#nesting)), so a row written in several levels, like a wall, is stored once, and a row that isn't 24 bytes is a compile error.

What makes storage that lasts, and nothing else does:

- **`data`** is laid out when the program is compiled and lives as long as the instance. Zeros take no room in the file.
- **A string or other literal** used as a pointer or slice is in the data section too, and equal constant ones may share their bytes.
- **`&` of a literal** is a cell of its own for that place in the source, reused each time the expression runs: a pointer kept from an earlier run sees the values of the later one.

Everything else, `let` variables and struct values included, is held in registers.

Starting over is `init(seed)`: it zeroes the world in one `memory.fill` (`world-bytes[..] = 0`) and keeps the best score, and `game.test.ts` checks that a restarted game plays frame for frame as a new one does.

## Start your own

1. Copy this directory somewhere.
2. Write your game in `starter.ents`. Keep its first section (the input bits and the commands), and change the rest.
3. In `build.ts`, list your game where it lists `lantern` and `starter`, and in `index.html`, name its `.wasm`.
4. Build with `ENCANTIS=encantis bun build.ts` (the variable points at an installed compiler; inside this repository it isn't needed), and serve `dist/`.

`encantis test starter.ents` runs the inline tests, which play frames without a browser.

## Tests

`bun test examples/browser` builds both games and checks, without a browser:

- that they import nothing and export what `host.js` calls;
- 10,000 frames of changing input: never more commands than the list holds, every number finite, the memory never grown;
- that a game started over after it ended draws the same frames as a new one;
- that several instances run side by side as they do alone;
- that a bot that sees only the drawing commands (it steers for the spark circles and dashes at the wisp circles) clears the first room;
- that `readCommands` gives each command to its handler, with its text read from memory.

Each `.ents` file also has inline tests, which `bun test` runs with the other examples.
