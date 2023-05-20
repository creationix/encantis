## Core Types

`i32`, `i64`, `f32`, and `f64` are the builtin types in the compiled output.

Encantis extends this slightly with `u32` and `u64`.

Encantis also has a slice type `[X]` where `X` is some other type.  This is usually written like `[u8]` which would be a byte slice.  This compiles to two `i32` numbers (pointer offset and length)

Also considered is null terminated and fixed/length arrays like `[u8/0]` for a c-string style null-terminated pointer or `[u8;8]` for exactly 8 bytes as a u8 array.

## Literal Types

Literals in code have an abstract type that can be coerced to many other types.  For example:

`100` in code is type `Integer`.  But if it's passed to a function that expects `i32` then it will become `i32`.

`"Hello"` in code is type `String`, but if it's passed to `[u8]` it will be inserted into the data section and become a tuple as `(pointer length)` of type `[u8]`.  If it's passed to `[u8/0]` it will be inserted into data with a null terminator and be passed as single pointer.

## Nibs Type

When literals are coerced to nibs, they are encoded using nibs encoding and are sent as a `[u8]` with Nibs using a slice tuple pair.

TODO: allow user defined types to do this

## Type Annotations

Literal values can have optional type annotations to immediatly give them a concrete type.  For example `1:i32` is different than `1:f32` or `"Hi":Nibs`

## Function Types

All arguments to a function must have a specified type as well as the return types.  When calling a function the type of that expression is the return type and all parameters passed in must fit into the specified argument types.

## Dynamic Literals

TODO: figure this out!