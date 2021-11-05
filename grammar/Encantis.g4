grammar Encantis;

program: statement* EOF;

statement:
	COMMENT
	| 'interface' USERTYPE ':' type
	| 'type' USERTYPE ':' type
	| importStatement
	| expr;

importStatement: 'import' STRING declaration;

declaration: 'func' IDENT? (<assoc = right> type '->' type);

expr:
	expr ('*' | '/' | '%') expr
	| expr ('+' | '-') expr
	| number
	| IDENT
	| STRING;

type:
	USERTYPE
	| ('*' | '?') type
	| 'i8'
	| 'i16'
	| 'i32'
	| 'i64'
	| 'u8'
	| 'u16'
	| 'u32'
	| 'u64'
	| 'f32'
	| 'f64'
	| 'externref'
	| 'funcref'
	| '[' type ('/0' | ARRAY_LEN)? ']'
	| '(' ((IDENT ':')? type)* ')'
	| <assoc = right> type '->' type;

number: BINARY | OCTAL | DOZENAL | HEXAGONAL | FLOAT | DECIMAL;

WS: [ \t\r\n]+ -> skip; // skip spaces, tabs, newlines
ARRAY_LEN: [*][0-9]+;
USERTYPE: [A-Z][A-Za-z0-9-]*;
IDENT: [a-z][a-zA-Z0-9-]*;
BINARY: '-'? '0' [bB][0-1]+;
OCTAL: '-'? '0' [oO][0-7]+;
DOZENAL: '-'? '0' [dD][0-9a-bA-B]+;
HEXAGONAL: '-'? '0' [xX][0-9a-fA-F]+;
FLOAT: '-'? [0-9]* '.' [0-9]+;
DECIMAL: '-'? [0-9]+;
STRING: '"' ~('"' | '\r' | '\n')* '"';
COMMENT: '--' ~( '\r' | '\n')*;