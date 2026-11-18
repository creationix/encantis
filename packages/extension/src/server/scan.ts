// =============================================================================
// What a place in the text is in: code, a comment, or a literal
// =============================================================================

// A comment, a string or a literal in single quotes ('a', 'ok') from quote to
// quote, or a piece of a template's text, from its backtick or the } that
// closes an interpolation to its closing backtick or the next ${ (the
// delimiters are not the piece's). `open` where the text ends before it does.
export interface Piece {
  kind: 'comment' | 'quoted' | 'text';
  start: number;
  end: number;
  open: boolean;
}

// The pieces of the text, read from its start past comments and escapes, in
// order, up to the one that `until` is in or on. Each can go on over lines, a
// template's text most of all, and only from the start of the text is it
// known whether a line starts in one. What a template's ${...} holds is read
// as code, where a quote may hold a } or a backtick.
export function* pieces(text: string, until: number): Generator<Piece> {
  // For each ${ that is open, how many braces were open where it opened:
  // the } that closes it is the one that leaves that many open.
  const interpolations: number[] = [];
  let braces = 0;
  let i = 0;
  while (i < text.length && i <= until) {
    const ch = text[i];
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      // A line comment ends at its line's end, which is no part of it.
      const line = text[i + 1] === '/';
      const at = text.indexOf(line ? '\n' : '*/', i + 2);
      const end = at === -1 ? text.length : line ? at : at + 2;
      yield { kind: 'comment', start: i, end, open: at === -1 && !line };
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1;
      const end = Math.min(i + 1, text.length);
      yield { kind: 'quoted', start, end, open: i >= text.length };
      i = end;
      continue;
    }
    if (ch === '`' || (ch === '}' && interpolations.at(-1) === braces)) {
      if (ch === '}') interpolations.pop();
      const start = i + 1;
      i = start;
      while (i < text.length && text[i] !== '`' && !(text[i] === '$' && text[i + 1] === '{')) i += text[i] === '\\' ? 2 : 1;
      yield { kind: 'text', start, end: Math.min(i, text.length), open: i >= text.length };
      if (i < text.length && text[i] === '$') {
        interpolations.push(braces);
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    i++;
  }
}

// The piece that `offset` is in or on, or null in code. The end of the text
// is in a piece that is open there.
export function pieceAt(text: string, offset: number): Piece | null {
  for (const piece of pieces(text, offset)) {
    if (offset >= piece.start && (offset < piece.end || (piece.open && offset === piece.end))) return piece;
  }
  return null;
}

// The literal that `offset` is in or on (a string, one in single quotes, a
// piece of a template's text), as a word: null in code and in a comment.
export function literalAt(text: string, offset: number): { word: string; start: number; end: number } | null {
  const piece = pieceAt(text, offset);
  if (!piece || piece.kind === 'comment' || offset >= piece.end) return null;
  return { word: text.slice(piece.start, piece.end), start: piece.start, end: piece.end };
}
