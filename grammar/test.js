import antlr4 from 'antlr4';
import EncantisParser from "./EncantisParser.js"
import EncantisLexer from "./EncantisLexer.js"

for (const [start, input] of [
  ['type', `[[u8]]`],
  ['type', `*(i32 u32 i64 u64 f32 f64)`],
  ['type', `?([u8/0] i32)`],
  ['type', `[u32*12]`],
  ['type', `(u32)`],
  ['type', `()`],
  ['type', `( name:[u8] age:i32 )`],
  ['type', `funcref`],
  ['type', `externref`],
  ['type', `i32 -> i64 -> u32`],
  ['type', `(a:i32 b:i32) -> () -> funcref`],
  ['expr', `1 + 2 * 3 + 4`],
  ['program', '-- Interface is a non-unique type.\ninterface Point: (f32 f32)'],
  ['statement', `type String: [u8]`],
  ['statement', `import "print" func print (String) -> void`],
]) {
  console.log(`\x1b[0;36m${input}\x1b[0m 🪄  \x1b[0;35m${test(start, input)}\x1b[0m`)
}

function test(start, input) {
  const chars = new antlr4.InputStream(input);
  const lexer = new EncantisLexer(chars);
  const tokens = new antlr4.CommonTokenStream(lexer);
  const parser = new EncantisParser(tokens);
  parser.buildParseTrees = true;
  const tree = parser[start]();
  return tree.toStringTree(parser.ruleNames)
}
