grammar Encantis;

WS: [ \t\r\n]+ -> skip; // skip spaces, tabs, newlines

ARRAY_LEN: [*][0-9]+;
USERTYPE: [A-Z][A-Za-z0-9-]*;
IDENT: [a-z][a-zA-Z0-9-]*;

type:
	USERTYPE
	| ('*'|'?') type
	| 'i8' | 'i16' | 'i32' | 'i64'
	| 'u8' | 'u16' | 'u32' | 'u64'
	| 'f32'| 'f64'
	| 'externref'
	| 'funcref'
	| '[' type ('/0' | ARRAY_LEN)? ']'
	| '(' ((IDENT ':')? type)* ')'
	| <assoc=right> type '->' type;

