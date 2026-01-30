
## Reference first Semantics

In C, pointers are address first and then thing they point to second.  To read the address of a pointer, you simply read it as-is.  The value is the address.  But if you want to read the thing it points to, you have to dereference it which means to do a typed memory read at that address.

```c
int* p = ...;          // p is a pointer to an int
int address = (int)p;  // read the address of the pointer
int value = *p;        // dereference the pointer to read the value
```

But what if we had a systems language that felt more like a scripting language by putting the value first and then the address second?  This is what reference first semantics are about.  In a reference first language, reading a pointer gives you the value directly.  To get the address, you have to take the reference of the value.

In webassembly there is no such thing as addresses to stack allocated values.  There is only registers (aka local variables which can be integers or floats) and linear memory (which is a big array of bytes).

Sinve the registers are fixed at compile time, it is not possible to store arrays on the stack, they must exist in linear memory.  And by default, wasm doesn't have any memory allocator so you can't dynamically allocate memory.  This means that arrays must be statically allocated in linear memory.

so how do you write useful programs with only having stack registers (ints and floats) and static serialized values in linear memory?

Part of the answer is to use reference first semantics.  In other words, pointers are values first and addresses second.  To make this more clear, we call them references instead of pointers.  You still can't get addresses to local variables and you can't dynamically allocate memory (at least not without a userspace memory allocator).  But you can automatically intern all array literal, string literal, tuple literal, struct literal, enum literal, etc into linear memory at compile time using the data section and then refereces to those values can be passed around in registers.

## Value Types

Before we talk about how to address values, we need to talk about what the values are and how they can be serialized into linear memory.

### Primitive Types

We have all the usual primitive number types: i8, u8, i16, u16, i32, u32, i64, u64, f32, f64.  We also support larger powers of two for integers like i128, u128, i256, u256, i512, u512, i1024, and u1024.  These larger integer types are implemented in software since wasm only has native support for up to 64 bit integers.

### Composite Types

We have arrays, tuples, structs, and enums as composite types.  All of these can be serialized into linear memory in a straightforward way.

#### Arrays

Arrays can be serizlied in various ways.

- Fixed length arrays can be serialized as contiguous blocks of memory.
- Variable length arrays can be serialized with a length prefix followed by the elements.
- Variable length arrays can also be serialized with a null terminator after the elements.
