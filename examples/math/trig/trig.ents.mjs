import { readFileSync } from "node:fs"

// Load trig.ents.wasm with fetch and compile
async function run() {
  const bytes = readFileSync('trig.wasm')
  const { instance: { exports: {
    from_polar, to_polar, _start, memory
  } } } = await WebAssembly.instantiate(bytes, {
    math: {
      sin: Math.sin,
      cos: Math.cos,
      atan2: Math.atan2
    },
    sys: {
      "print-f64-pair": (ptr1, len1, f1, ptr2, len2, f2, ptr3, len3) => {
        const str1 = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr1, len1));
        const str2 = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr2, len2));
        const str3 = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr3, len3));
        console.log(`${str1}${f1}${str2}${f2}${str3}`);
      }
    }
  });

  console.log("=== JS Direct Function Tests ===");

  const [r, theta] = to_polar(3.1, 4.2);
  console.log(`Polar coordinates: r=${r}, theta=${theta}`);

  const [x, y] = from_polar(r, theta);
  console.log(`Cartesian coordinates: x=${x}, y=${y}`);

  console.log("=== WAT _start Function Output ===");

  // Run _start
  _start();
}
run();

