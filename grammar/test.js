import antlr4 from 'antlr4';
import EncantisParser from "./EncantisParser.js"
import EncantisLexer from "./EncantisLexer.js"

for (const str of [
  `[[u8]]`,
  `*(i32 u32 i64 u64 f32 f64)`,
  `?([u8/0] i32)`,
  `[u32*12]`,
  `(u32)`,
  `()`,
  `( name:[u8] age:i32 )`,
  `funcref`,
  `externref`,
  `i32 -> i64 -> u32`,
  `(a:i32 b:i32) -> () -> funcref`,
]) {
  console.log(`\x1b[0;36m${str}\x1b[0m 🪄  \x1b[0;35m${test(str)}\x1b[0m`)
}

function test(input) {
  const chars = new antlr4.InputStream(input);
  const lexer = new EncantisLexer(chars);
  const tokens = new antlr4.CommonTokenStream(lexer);
  const parser = new EncantisParser(tokens);
  parser.buildParseTrees = true;
  const tree = parser.type();
  return tree.toStringTree(parser.ruleNames)
}
