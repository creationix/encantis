grammar Program;
program: statement*;

statement:
	imports
	| exports
	| internals
	| unique
	| alias
	| func;

imports: 'import' typedIdentifiers;

exports: 'export' typedIdentifiers;

internals: 'internal' typedIdentifiers;

unique: 'unique' typeDefinition;

alias: 'alias' typeDefinition;

func: 'func' IDENTIFIER receiver funcBody;

typeDefinition: USERTYPE ':' type;

typedIdentifier: IDENTIFIER ':' type;

typedIdentifiers: typedIdentifier | typedIdentifierBlock;

typedIdentifierBlock: '{' typedIdentifier* '}';

USERTYPE: [A-Z][A-Za-z0-9-]*;

IDENTIFIER: [a-z][A-Za-z0-9-]*;

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

funcBody: arrowBody | blockBody;

arrowBody: '=>' expression;

blockBody: expression* ('return' expression?)? 'end';

receiver: IDENTIFIER | tupleReceiver;

tupleReceiver: '(' receiver (',' receiver)* ')';

expression:
	NUMBER
	| STRING
	| binaryExp
	| call
	| tuple
	| IDENTIFIER
	| access
    | lambda;

NUMBER: [0-9]+;

STRING: ["][^"]* ["];

access: '.' INTEGER;

lambda: receiver '=>' expression;

INTEGER: [0-9]+;

binaryExp: expression binop expression;

binop: '+' | '-' | '*' | '/' | '%';

tuple: '(' expression (',' expression)* ')';

call: IDENTIFIER tuple;