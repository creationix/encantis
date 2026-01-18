# Encantis Compiler Internals

This document describes the internal representation of types and AST nodes, and the APIs for parsing and type checking.

## Compiler Pipeline

```
Source Code
    │
    ▼ parse()
AST (Abstract Syntax Tree)
    │
    ▼ check()
TypeCheckResult
    │
    ├── types: Map<offset, ResolvedType>
    ├── symbols: Map<name, Symbol>
    ├── errors: TypeError[]
    └── literalRefs: Map<offset, DataRef>
```

**Key files:**
- `tools/ast.ts` - AST type definitions
- `tools/types.ts` - ResolvedType definitions and type utilities
- `tools/parser.ts` - Parser API
- `tools/checker.ts` - Type checker
- `tools/type-lib.ts` - Type string parsing utilities

## AST Types

AST nodes represent the syntactic structure of source code. All nodes include a `span` with byte offsets for source mapping.

### Core Structure

```typescript
interface Span {
  start: number  // byte offset
  end: number    // byte offset
}

interface Module {
  kind: 'Module'
  decls: Declaration[]
  span: Span
}
```

### Example: Parsing a Function

**Input:**
```encantis
func add(a: i32, b: i32) -> i32 {
  return a + b
}
```

**AST Output:**
```typescript
{
  kind: 'FuncDecl',
  inline: false,
  ident: 'add',
  signature: {
    kind: 'FuncSignature',
    params: {
      kind: 'FieldList',
      fields: [
        { kind: 'Field', ident: 'a', type: { kind: 'PrimitiveType', name: 'i32' } },
        { kind: 'Field', ident: 'b', type: { kind: 'PrimitiveType', name: 'i32' } }
      ]
    },
    returns: { kind: 'PrimitiveType', name: 'i32' }
  },
  body: {
    kind: 'Block',
    stmts: [{
      kind: 'ReturnStmt',
      value: {
        kind: 'BinaryExpr',
        op: '+',
        left: { kind: 'IdentExpr', name: 'a' },
        right: { kind: 'IdentExpr', name: 'b' }
      }
    }]
  }
}
```

### AST Type Nodes

Types in the AST mirror the source syntax:

| AST Type | Example | Description |
|----------|---------|-------------|
| `PrimitiveType` | `i32`, `u8`, `f64`, `bool` | Built-in types |
| `PointerType` | `*i32`, `*[u8]` | Pointer to type |
| `IndexedType` | `[u8]`, `*[!u8]`, `*[10;i32]` | Array/slice types |
| `CompositeType` | `(x: i32, y: i32)` | Tuple/struct types |
| `TaggedType` | `u8@Index` | Unique tagged type |
| `TypeRef` | `Point`, `MyType` | Named type reference |
| `ComptimeIntType` | `int(42)` | Compile-time integer |
| `ComptimeFloatType` | `float(3.14)` | Compile-time float |

### Example: Array Type AST

**Input:** `*[!u8]` (pointer to null-terminated u8 array)

**AST:**
```typescript
{
  kind: 'PointerType',
  pointee: {
    kind: 'IndexedType',
    element: { kind: 'PrimitiveType', name: 'u8' },
    size: null,           // null = slice, number = fixed, 'comptime' = comptime list
    specifiers: [{ kind: 'null' }]  // ! = null terminator
  }
}
```

**Input:** `*[10;i32]` (pointer to fixed array of 10 i32s)

**AST:**
```typescript
{
  kind: 'PointerType',
  pointee: {
    kind: 'IndexedType',
    element: { kind: 'PrimitiveType', name: 'i32' },
    size: 10,
    specifiers: []
  }
}
```

## Resolved Types

After type checking, AST types are converted to `ResolvedType` - semantic types with all references resolved and no source spans.

### ResolvedType Variants

```typescript
type ResolvedType =
  | PrimitiveRT      // i32, u8, f64, bool
  | PointerRT        // *T
  | IndexedRT        // [T], *[T], *[N;T], *[!T], *[?T]
  | TupleRT          // (T, T) or (x: T, y: T)
  | FuncRT           // func(T) -> T
  | VoidRT           // ()
  | ComptimeIntRT    // int(value) - coerces to any fitting integer
  | ComptimeFloatRT  // float(value) - coerces to f32 or f64
  | ComptimeListRT   // [expr, expr, ...] - untyped array literal
  | NamedRT          // type aliases and unique types
```

### IndexedRT (Array Types)

The `IndexedRT` type represents all array-like types:

```typescript
interface IndexedRT {
  kind: 'indexed'
  element: ResolvedType        // Element type
  size: number | 'comptime' | null
    // number   = fixed size [N;T]
    // null     = slice (fat pointer) *[T]
    // 'comptime' = comptime list [T]
  specifiers: IndexSpecifierRT[]
    // { kind: 'null' }   = null-terminated (!)
    // { kind: 'prefix', prefixType: 'leb128' } = LEB128 length prefix (?)
}
```

### Example: Type Resolution

**Input:** `let msg: *[!u8] = "hello"`

**ResolvedType for `msg`:**
```typescript
{
  kind: 'pointer',
  pointee: {
    kind: 'indexed',
    element: { kind: 'primitive', name: 'u8' },
    size: null,
    specifiers: [{ kind: 'null' }]
  }
}
```

**ResolvedType for `"hello"` literal (before coercion):**
```typescript
{
  kind: 'indexed',
  element: { kind: 'primitive', name: 'u8' },
  size: 'comptime',
  specifiers: []
}
```

### Type Constructors

Helper functions to create ResolvedType values:

```typescript
import { primitive, pointer, indexed, slice, array, tuple, func, VOID,
         comptimeInt, comptimeFloat, comptimeList, named, field } from './types'

// Primitives
primitive('i32')     // → { kind: 'primitive', name: 'i32' }

// Pointers
pointer(primitive('u8'))  // → *u8

// Arrays/slices
slice(primitive('u8'))         // → *[u8] (fat pointer)
array(primitive('i32'), 10)    // → [10;i32] (inline fixed)
indexed(primitive('u8'), null, [{ kind: 'null' }])  // → *[!u8]

// Tuples
tuple([
  field('x', primitive('i32')),
  field('y', primitive('i32'))
])  // → (x: i32, y: i32)

// Functions
func(
  [field('a', primitive('i32'))],  // params
  [field(null, primitive('i32'))]  // returns
)  // → func(a: i32) -> i32

// Comptime values
comptimeInt(42n)     // → int(42)
comptimeFloat(3.14)  // → float(3.14)
```

## Parser API

### Parsing Source Code

```typescript
import { parse } from './parser'

const source = `
func main() {
  let x: i32 = 42
}
`

const result = parse(source)

if (result.errors.length > 0) {
  console.error('Parse errors:', result.errors)
} else {
  console.log('AST:', result.module)
}
```

**ParseResult:**
```typescript
interface ParseResult {
  module: Module | null  // AST if successful
  errors: ParseError[]   // Parse errors
}

interface ParseError {
  message: string        // Full error message
  shortMessage: string   // Brief description
  span: Span            // Error location
  expected: string[]    // Expected tokens
}
```

### Parsing Type Strings

For testing or tools that need to parse type strings directly:

```typescript
import { parseType, parseTypeAST, astToResolved } from './type-lib'

// Parse directly to ResolvedType
const type = parseType('*[!u8]')
// → { kind: 'pointer', pointee: { kind: 'indexed', ... } }

// Parse to AST first
const ast = parseTypeAST('(x: i32, y: i32)')
// → { kind: 'CompositeType', fields: [...] }

// Convert AST to ResolvedType
const resolved = astToResolved(ast)
// → { kind: 'tuple', fields: [...] }
```

### Type String Formatting

Convert ResolvedType back to a string:

```typescript
import { typeToString } from './types'

const type = pointer(indexed(primitive('u8'), null, [{ kind: 'null' }]))
console.log(typeToString(type))  // → "*[!u8]"
```

## Type Checker API

### Checking a Module

```typescript
import { parse } from './parser'
import { check } from './checker'

const source = `
func add(a: i32, b: i32) -> i32 {
  return a + b
}
`

const parseResult = parse(source)
if (!parseResult.module) {
  throw new Error('Parse failed')
}

const checkResult = check(parseResult.module)

if (checkResult.errors.length > 0) {
  for (const err of checkResult.errors) {
    console.error(`Error at offset ${err.offset}: ${err.message}`)
  }
} else {
  console.log('Type check passed')
}
```

### TypeCheckResult

```typescript
interface TypeCheckResult {
  // Type of each expression, keyed by AST node start offset
  types: Map<number, ResolvedType>

  // Module-level symbol table
  symbols: Map<string, Symbol>

  // Type errors
  errors: TypeError[]

  // Reference tracking: definition offset → reference offsets
  references: Map<number, number[]>

  // Reverse lookup: usage offset → definition offset
  symbolRefs: Map<number, number>

  // Symbol name → definition offset
  symbolDefOffsets: Map<string, number>

  // Literal refs: AST offset → DataRef for serialized data
  literalRefs: Map<number, DataRef>

  // Data section builder for codegen
  dataBuilder: DataSectionBuilder
}
```

### Accessing Expression Types

```typescript
const checkResult = check(module)

// Get type of expression at a specific offset
const exprType = checkResult.types.get(42)  // offset 42
if (exprType) {
  console.log('Type:', typeToString(exprType))
}
```

### Symbol Kinds

```typescript
type Symbol =
  | { kind: 'type'; type: ResolvedType; unique: boolean }
  | { kind: 'func'; type: FuncRT; inline: boolean }
  | { kind: 'global'; type: ResolvedType }
  | { kind: 'def'; type: ResolvedType }      // compile-time constant
  | { kind: 'local'; type: ResolvedType }    // local variable
  | { kind: 'param'; type: ResolvedType }    // function parameter
  | { kind: 'return'; type: ResolvedType }   // named return value
```

## Type Assignability

Check if one type can be assigned to another:

```typescript
import { typeAssignable, typeAssignResult } from './types'

// Simple check
const ok = typeAssignable(targetType, sourceType)  // → boolean

// Detailed result
const result = typeAssignResult(targetType, sourceType)
if (result.compatible) {
  console.log('Lossiness:', result.lossiness)  // 'lossless' or 'lossy'
  console.log('Reinterpret:', result.reinterpret)  // true if same bit pattern
}
```

**Assignability rules:**
- Exact type matches are always allowed
- Comptime integers coerce to any integer type that fits the value
- Comptime floats coerce to f32 or f64
- Integer widening is implicit (i8 → i32 is lossless)
- Narrowing requires explicit cast (lossy)
- Comptime lists coerce to pointer-to-indexed types

## Two-Phase Type Checking

The checker operates in two passes:

**Pass 1: Collection**
- Collect all type declarations, function signatures, globals
- Build the symbol table
- No expression type checking yet

**Pass 2: Checking**
- Type check function bodies
- Infer types for expressions
- Validate assignments and calls
- Collect literals for data section serialization

This allows forward references - a function can call another function defined later in the file.

## Comptime Types

Comptime types represent values known at compile time that can coerce to multiple runtime types:

| Comptime Type | Can Coerce To |
|---------------|---------------|
| `int(42)` | Any integer type where 42 fits (i8, u8, i32, u64, etc.) |
| `float(3.14)` | f32 or f64 |
| `[u8]` (comptime list) | `*[u8]`, `*[!u8]`, `*[?u8]`, `*[N;u8]` |

**Example:**
```encantis
let a: u8 = 100      // int(100) coerces to u8 ✓
let b: u8 = 256      // int(256) doesn't fit in u8 ✗
let c: *[!u8] = "hi" // [u8] coerces to *[!u8] ✓
```
