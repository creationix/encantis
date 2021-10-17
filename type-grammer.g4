grammar Type;
type:
	USERTYPE
	| tupleType
	| sliceType
	| pointerType
	| arrayType
	| maybeType
	| builtinType
	| functionType;

extendedType: type | smallType;

tupleType: '(' type* ')';

sliceType: '<' extendedType '>';

pointerType: '*' extendedType;

arrayType: '#' extendedType;

maybeType: '?' extendedType;

builtinType: 'i32' | 'u32' | 'i64' | 'u64' | 'f32' | 'f64';

smallType: 'i8' | 'u8' | 'i16' | 'u16';

functionType: type '->' type;

USERTYPE: [A-Z][A-Za-z0-9-]*;
