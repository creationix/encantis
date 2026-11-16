# lib

Small helpers written in Encantis, for programs that read text and print results (Advent of Code style). They're plain source files: import them by relative path, or copy them next to your program. Nothing here allocates. Input goes into a buffer you provide, and parsing returns slices of it.

## io.ents

Standard input and output over WASI, for programs run with `encantis run`.

| Function | What it does |
| --- | --- |
| `read_all(buf: []mut u8) -> []u8` | Reads all of stdin into `buf`, returns the filled part |
| `print(s: []u8)`, `println(s: []u8)` | Writes `s` (and a newline) to stdout |
| `print_u64(n: u64)`, `print_i64(n: i64)` | Writes a number and a newline |

## text.ents

| Function | What it does |
| --- | --- |
| `eq(a, b) -> bool`, `starts_with(s, prefix) -> bool` | Compare bytes |
| `index_of(s, c) -> u32` | First index of byte `c`, or `s.len` |
| `split_once(s, c) -> (head, rest)` | Split at the first `c` |
| `next_line(s) -> (line, rest)` | The first line (without `\n`) and what follows |
| `skip_spaces(s) -> []u8` | `s` without leading spaces |
| `parse_u64(s) -> (value, rest, ok)`, `parse_i64(...)` | A decimal number after any spaces, and what follows it |

## Using them

Source imports list the functions they use, with their signatures:

```ents
import "../lib/io" (
  "read_all" func read_all(buf: []mut u8) -> []u8
  "print_u64" func print_u64(n: u64)
)
import "../lib/text" (
  "next_line" func next_line(s: []u8) -> (line: []u8, rest: []u8)
)

export memory

data input = mut [0:u8; 65536]

export "_start" func main() {
  let text = read_all(input)
  // ...
}
```

`examples/aoc/day1.ents` is a complete program: `encantis run examples/aoc/day1.ents < input.txt`.
