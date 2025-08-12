import { readFileSync } from "node:fs"

// Load trig.ents.wasm with fetch and compile
async function run() {
  const bytes = readFileSync('trig.ents.wasm')
  const { instance: { exports: {
    from_polar, to_polar
  } } } = await WebAssembly.instantiate(bytes, {
    math: {
      sin: Math.sin,
      cos: Math.cos,
      atan2: Math.atan2
    }
  });

  // Convert polar to Cartesian coordinates
  const [x, y] = from_polar(5, Math.PI / 4);
  console.log(`Cartesian coordinates: x=${x}, y=${y}`);

  // Convert back to polar coordinates
  const [r, theta] = to_polar(x, y);
  console.log(`Polar coordinates: r=${r}, theta=${theta}`);
}
run();

