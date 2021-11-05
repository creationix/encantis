grammar Encantis;

WS: [ \t\r\n]+ -> skip; // skip spaces, tabs, newlines

type:
	USERTYPE
	| tupleType
	| sliceType
	| pointerType
	| maybeType
	| 'i32'
	| 'u32'
	| 'i64'
	| 'u64'
	| 'f32'
	| 'f64'
	| 'void'
	| 'externref'
	| 'funcref'
	| type '->' type;

tupleType: '(' type* ')';

NUM: [0-9]+;

sliceType: '[' (type | virtualType) ('/0' | '*' NUM)? ']';

pointerType: '*' (type | virtualType);

maybeType: '?' (type | virtualType);

virtualType: 'i8' | 'u8' | 'i16' | 'u16';

USERTYPE: [A-Z][A-Za-z0-9-]*;
