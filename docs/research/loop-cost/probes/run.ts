// bun run.ts <a.wasm> : calls the bug probes, prints JSON
import { readFileSync } from 'node:fs'
const bin = readFileSync(process.argv[2])
const ex = (await WebAssembly.instantiate(bin, {})).instance.exports as any
const t = (f: () => unknown) => { try { return f() } catch (e: any) { return 'trap: ' + e.message } }
console.log(JSON.stringify({
  'count8((0xFFFFFFF0,32))': t(() => ex.count8(0xFFFFFFF0 | 0, 32)),
  'count32((64,0x40000001))': t(() => ex.count32(64, 0x40000001)),
  'count8((65530,10))': t(() => ex.count8(65530, 10)),
  'by_index8((0xFFFFFFF0,32))': t(() => ex.by_index8(0xFFFFFFF0 | 0, 32)),
  'arr_ptr(0xFFFFFFF8)': t(() => ex.arr_ptr(0xFFFFFFF8 | 0)),
  'arr_ptr(65528)': t(() => ex.arr_ptr(65528)),
  'arr_ptr_huge(4096)': t(() => ex.arr_ptr_huge(4096)),
  'c_assign_signed(5)': t(() => ex.c_assign_signed(5)),
  'idx_assigned8((0xFFFFFFF0,32))': t(() => ex.idx_assigned8(0xFFFFFFF0 | 0, 32)),
  'idx_assigned8((8,3))': t(() => ex.idx_assigned8(8, 3)),
  'c_assign_unsigned(5)': t(() => ex.c_assign_unsigned(5)),
}))
