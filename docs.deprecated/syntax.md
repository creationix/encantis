
# Syntax

## Comments

Line comments are the same as Lua and Haskell with `--`.  For example:

```ents
-- This is a comment
```

## Types

Despite being a very simple language that only generates [wat](https://webassembly.github.io/spec/core/text/index.html), there is a powerful and zero-cost type system to help writing code.

Most type annotations follow a `:` character.  In many places the type annotation can be omitted and will be inferred.  For example:

```ents
-- Declare a variable with a type
var x: i64
-- Declare and initialize a variable with `i32` inferred as the type
var y = 10
```

### Builtin Types

The builtin types are numeric types `i32`, `u32`, `i64`, `u64`, `f32`, and `f64`.  Note that the signedness only matters to the type system.  In wasm it's just `i32` and `i64` for integers.

### Tuple Type

A tuple is simply a fixed amount of multiple types combined.  The syntax is `(` followed by the types and ended with `)`. For example:

```ents
(i32 i32)
```

Values that are of type tuple can be destructured or accessed using numerical properties (`.1`, `.2`, etc).  For example:

```ents
-- point has inferred type `(i32 i32)`
var point = (10 20)
-- a and b have inferred type `i32`
var (a b) = point
-- This is the first value
point.1
-- This is the second value
point.2
```

This compiles roughly to:

```wat
;; point has inferred type `(i32 i32)`
(local $point_1 i32)
(local $point_2 i32)
;; a and b have inferred type `i32`
(local $a i32)
(local $b i32)
(set_local $a (get_local $point_1))
(set_local $b (get_local $point_2))
;; This is the first value
get_local $point_1
;; This is the second value
get_local $point_2
```

### Struct Type

A struct is just like a tuple, except each value is named and it's framed with `{` and `}`.  These can be destructured or accessed using properties. For example:

```ents
-- point has inferred type `{ x:i32 y:i32 }`
var point = {
  x = 3
  y = 5
}
-- .x is type `i32` and value 3
point.x
-- .y is type `i32` and value 5
point.y
-- x and y are inferred type i32
var {x y} = point
```

This compiles roughly to:

```wat
;; point has inferred type `{ x:i32 y:i32 }`
(local $point_x i32)
(local $point_y i32)
i32.const 3
set_local $point_x
i32.const 5
set_local $point_y
;; .x is type `i32` and value 3
get_local $point_x
;; .y is type `i32` and value 5
get_local $point_y
;; x and y are inferred type i32
(local $x i32)
(local $y i32)
get_local $point_x
set_local $x
get_local $point_y
set_local $y
```

Structs have structural matching.  A superset of matching properties can be used for a struct that is a subset.  For example:

```ents
-- point has inferred type `{x:f32 y:f32 z:f32}`
local point = ( x=1f y=2f z=3f)
-- but 2dDistance accepts `{x:f32 y:f32}` and simply passes the 
-- matching subset ignoring the `z` property.
2dDistance(point)
```

This compiles roughly to:

```wat
;; point has inferred type `{x:f32 y:f32 z:f32}`
(local $point_x f32)
(local $point_y f32)
(local $point_z f32)
(set_local $point_x (f32.const 1))
(set_local $point_y (f32.const 2))
(set_local $point_z (f32.const 3))
;; but 2dDistance accepts `{x:f32 y:f32}` and simply passes the 
;; matching subset ignoring the `z` property.
(call $2dDistance 
  (get_local $point_x)
  (get_local $point_y)
)
```

### Pointer Type

A pointer is encoded in wasm as a simple `u32` offset into the linear memory, but the type tells us the shape of what it's pointing to.  The syntax is `*` followed by the type.  This allows small types as well as complex types. For example:

```ents
-- pointer to a number
var a: *i32
-- Reference and dereference the pointer
test(a, *a)
```

```wat
;; pointer to a number
(local $a u32)
;; Reference and dereference the pointer
(call $test
  (get_local $a)
  (i32.load (get_local $a))
)
```

```ents
-- ponter to a small number
local b: *u8
-- Reference and dereference the pointer
test(b, *b)
```

```wat
;; ponter to a small number
(local $b u32)
;; Reference and dereference the pointer
(call $test
  (get_local $b)
  (i32.load8_u get_local $b)
)
```

```ents
-- pointer to a complex type
local c: *(u8 u16 u8)
-- access property directoy
c[1]
```

```wat
-- pointer to a complex type
(local $c u32)
-- access property directoy
(i32.load16_u (u32.add
    (get_local $c)
    (i32.const 2)
))
```

### Function Pointers

Functions can be first class values thanks to indirect call in wasm.  The pointer itself is a table index.

```ents
-- Function Pointers have types of inputs and outputs.
-- This points to a function that accepts two numbers
-- and returns one.
local ptr: (a:i32 b:i32) -> i32
-- Call the function pointer.
ptr(1, 2)
```

```wat
;; Generated type at module level
(type (;0;) (func (param i32 i32)(result i32)))

;; Function Pointers have types of inputs and outputs.
;; This points to a function that accepts two numbers
;; and returns one.
(local $ptr u32)
;; Call the function pointer.
(i32.const 1)
(i32.const 2)
(local_get $ptr)
(call_indirect (type 0))
```

### Pointers to Any Type

It's also possible to combined pointers with container types such as tuples and structs.

```ents
-- Pointer to 5 bytes in memory containing pointer to null terminated
-- string and single byte age.
local a: *(name:[u8/0] age:u8)
-- Load pointer to name
a.name
-- Load age
a.age
```

```wat
-- Pointer to 5 bytes in memory containing pointer to null terminated
-- string and single byte age.
(local $a u32)
-- Load pointer to name
(i32.load (local_get $a))
a.name
-- Load age
(i32.load8_u (i32.add
    (local_get $a)
    (i32.const 4)
))
```

Pointers can point to any type, including pointers, array pointers, even function pointers.

### Slice Type

A slice is an array pointer that also has a known length.  It's actually two `i32` values in wasm. The syntax is `[` type `]`. Just like array pointers, the small integer types can be used.  A common type for strings is `[u8]`.

This can be used like an array and has a `.len` property and a `.base` property.  There is no generated bounds checking at runtime.

```ents
-- Declare the variable
local word: [u8]
-- .len is type `u32`
word.len
-- .base is type `[u8*?]`
word.base
-- The lookup is `u8`, but `first` is `i32`.
local first = word[0]
```

The generated wat for this looks roughy like:

```wat
;; Declare the variable
(local $word_base u32)
(local $word_len u32)
;; .len is type `u32`
local_get $word_len
drop
-- .base is type `*[u8]`
local_get $word_base
drop
;; The lookup is `u8`, but `first` is `i32`.
(local $first i32)
local_get $word_base
i32.const 0
i32.add
i32.load8_u
local_set $first
```

### Interface Type

Interface types are simply shorthand names for types, they are identical to the fullly written out type.

```ents
interface Pair: (f32 f32)
```

Values and function parameters with type `Pair` are identical to `(f32 f32)` and can be used interchangibily.

### Unique Types

Unique types are like interface types, except they are not considered the same type and are a new type that requires manual casting in the compiler type system

```ents
-- Define a unique type for String that is implemented using a byte slice.
type String: [u8]
```

Then if a function accepts `String` type, a raw `variable` with type `<u8>` cannot be passed in, it needs to be explicitly cast using `String(variable)`.  This works for simple types too.

```ents
-- An index for a specefic use in the app, so it can't be mixed
-- with other indices in the app and be type safe.
type GameIndex: u32
```

## Functions

### Defining Functions

One idea is named params and results:

```ents
func add-sub (a:i32 b:i32) -> (c:i32 d:i32) {
  c = a + b
  d = a - b
}
```

This also works for non-tuple types

```ents
func negate a:i32 -> b:i32 {
  b = -a
}
```

Another idea is implicit inputs with `@` and outputs with `return`.

```ents
func add-sub (i32 i32) -> (i32 i32) {
    return (@.1 + @.2, @.1 - @.2)
}

func negate i32 -> i32 {
    return -@
}
```

We can have function literals with arrow style as long as it doesn't include
closure variables.

```ents
local add-sub: (i32 i32) -> (i32 i32) = 
    (a, b) => (a + b, a - b)

local negate: i32 -> i32 = 
    a => -a
```

These will generate anonymous global functions that are not exported.  Multiple functions with identical ASTs will be stored once and reused.

This makes higher-order functions possible.

```ents
fn fold(list: <i32>, fn: (i32 i32) -> i32) -> sum:i32 {
    -- Call fn over and over and return sum
}

-- Pass an anonymous function to convert `fold` into `sum`
var list: <i32>
var sum = fold(list, (accum, item) => accum + item)
```

### Function Application

```ents
add-sub(1 2)
```

### Function Pipine

```ents
(1 2)
    |add-sub
```

## Loops

```ents
loop ()
```

## Iterators

NOTE: this is a crazy idea and probably doesn't fit with the language, but it's interesting to see if it can fit.

The iterator interface is like a generic function pointer type.  The language doesn't have generics (yet), but this is a way to think about it.

```ents
interface Iterator<Value Entry State>: (Value State) -> (Entry State)
```

The definition itself is a kind of macro to allow defining custom iterators that look like keywords.

```ents
-- Define the interface for an iterator that loops over i32 slices
-- The State value always starts out 0.  When it returns zero again
-- iteration is done.
iterator each = (list, index) => (list[index], (index + 1) % list.len)

-- Consume using iterator name as if it was a keyword
each entry in list {
    -- entry it each `i32` in the slice
}
```

This generates to roughly:

```wat
(local $index u32)
(set_local $index 0)
()
...
```

NOTE: This might not be a good idea if we can't optimize away the cost using manual inlining or binaryen.

Two-Phase Iterator:

A iterator function returns a function pointer and a start state. The returned function returns each entry and a new state. It returns 0 for state when iteration should be done.

```ents
-- Just an idea, you wouldn't really do this for a struct
-- This made up function returns a tuple for each entry which
-- we then destructure
for (key, value) in pairs(struct) {

}
-- name is a byte array (aka string)
local name: [u8]
-- iterate over the bytes with indices
for (i, byte) in ipairs(name) {

}

-- An iterator function
var decr: i32->(i32 i32) =
  (i) => (i-1, i-1)

-- A function that generates an iterator (fn and state)
var range: i32 -> (i32->(i32 i32) i32) =
  i => (decr, i)

-- Using range
for i in range(10) {
    -- i iterates from 0 to 9
}

-- You can also pass in the iterator function and initial state directly.
for x in (decr, 10) {

}
```

## Control Flow Wasm Style

Wasm has 3 low-level control flow block types `block/end`, `loop/end`, and `if/else/end`.  In each of these you can `break` and `break-if` to arbitrary numbers of nested levels.  Breaks targetting `block` and `if/else` jump to end but breaks within `loop` jump to the start.

```ents
-- A simple while loop using low-level control flow
block-top
    loop
        br-if-top exp -- jump to end of `block` if true
        -- body of loop
        br -- jump to start of loop
    end
end

-- The above can be represented with while sugar
while exp do
  -- body of loop
  continue-if expr -- jump to start of loop if expression is true
  break -- jump to end of loop
  -- skipped body
end

-- A do..while loop using low-level control flow
block
    loop
        -- body of loop
        break-1-if exp -- jump to end of `block` if true
        break-0 -- jump to start of loop
    end
end

-- if/else
if cond then
  -- `then` is used to delimit between condition from the first body
  -- body of true
elif cond2 then
  -- elseif is just nested if blocks, but with less nesting and visual ends
  -- body of alternate truth
else
  -- body of false
  br-if cond -- jump to end if true
  -- more body
end

```
