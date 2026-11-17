# Generics

Generic functions: a function with a compile-time type parameter, compiled once for each type it is used with. Generic types, a type with type parameters, and comptime function parameters have their own sections at the end. The rules are the "Generics" chapter of [`docs/encantis.md`](../docs/encantis.md), whose own examples are run as tests too. This file holds the cases that are too detailed for the reference: how the new forms parse, programs at the edges of what is accepted, and one case for every error.

The accepted modules of this file are also compiled and validated (see [`README.md`](README.md)), so nothing is listed here as accepted that does not build.

<!-- spec:begin compile -->

## Declarations

A parameter marked `comptime` is a field with `comptime` set. The type of a type parameter is the keyword `type`. Ordinary parameters have no `comptime` key at all.

```ents FuncDecl
func max(comptime T: type, a: T, b: T) -> T => a
```

```json ast
{
  "kind": "FuncDecl",
  "inline": false,
  "ident": "max",
  "signature": {
    "kind": "FuncSignature",
    "input": {
      "kind": "CompositeType",
      "fields": [
        {
          "kind": "Field",
          "comptime": true,
          "ident": "T",
          "type": {
            "kind": "TypeType"
          }
        },
        {
          "kind": "Field",
          "ident": "a",
          "type": {
            "kind": "TypeRef",
            "name": "T"
          }
        },
        {
          "kind": "Field",
          "ident": "b",
          "type": {
            "kind": "TypeRef",
            "name": "T"
          }
        }
      ]
    },
    "output": {
      "kind": "TypeRef",
      "name": "T"
    }
  },
  "body": {
    "kind": "ArrowBody",
    "expr": {
      "kind": "IdentExpr",
      "name": "a"
    }
  }
}
```

`comptime` belongs to parameter lists. A struct type is a list of fields:

```ents
type P = (comptime T: type, x: T)
```

```errors
Expected
```

So is a result:

```ents
func f(a: u32) -> (comptime T: type) => a
```

```errors
Expected
```

`type` is not a type on its own:

```ents
func f(t: type) -> u32 => 0
```

```errors
Expected
```

`comptime` is a reserved word:

```ents
func comptime(a: i32) -> i32 => a
```

```errors
Expected
```

## Type arguments

A call argument that could not start an expression is parsed as a type. A bare type name:

```ents Expr
first(Pt, ps)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "first"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "TypeExpr",
        "type": {
          "kind": "TypeRef",
          "name": "Pt"
        }
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "ps"
      }
    }
  ]
}
```

A slice type:

```ents Expr
first([]u8, ps)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "first"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "TypeExpr",
        "type": {
          "kind": "IndexedType",
          "element": {
            "kind": "PrimitiveType",
            "name": "u8"
          },
          "size": null,
          "specifiers": []
        }
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "ps"
      }
    }
  ]
}
```

A pointer type:

```ents Expr
first(*mut Pt, ps)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "first"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "TypeExpr",
        "type": {
          "kind": "PointerType",
          "pointee": {
            "kind": "TypeRef",
            "name": "Pt"
          },
          "mutable": true
        }
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "ps"
      }
    }
  ]
}
```

A ranged integer:

```ents Expr
first(u8#16, ps)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "first"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "TypeExpr",
        "type": {
          "kind": "PrimitiveType",
          "name": "u8",
          "max": 16
        }
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "ps"
      }
    }
  ]
}
```

A function type:

```ents Expr
apply((u32) -> u32, f)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "apply"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "TypeExpr",
        "type": {
          "kind": "FuncType",
          "input": {
            "kind": "CompositeType",
            "fields": [
              {
                "kind": "Field",
                "ident": null,
                "type": {
                  "kind": "PrimitiveType",
                  "name": "u32"
                }
              }
            ]
          },
          "output": {
            "kind": "PrimitiveType",
            "name": "u32"
          }
        }
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "f"
      }
    }
  ]
}
```

A type that is also an expression stays an expression, and the checker reads it as a type where the parameter is one. A primitive is an identifier:

```ents Expr
max(u32, a, b)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "max"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "u32"
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "a"
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "b"
      }
    }
  ]
}
```

A tuple type is a tuple:

```ents Expr
first((i32, i32), ps)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "first"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "TupleExpr",
        "elements": [
          {
            "kind": "Arg",
            "name": null,
            "value": {
              "kind": "IdentExpr",
              "name": "i32"
            }
          },
          {
            "kind": "Arg",
            "name": null,
            "value": {
              "kind": "IdentExpr",
              "name": "i32"
            }
          }
        ]
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "ps"
      }
    }
  ]
}
```

Array literals are still array literals, also the ones that look like the start of an array type:

```ents Expr
f([], x)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "f"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "ArrayExpr",
        "elements": []
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "x"
      }
    }
  ]
}
```

```ents Expr
f([4], x)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "f"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "ArrayExpr",
        "elements": [
          {
            "kind": "LiteralExpr",
            "value": {
              "kind": "int",
              "value": "4",
              "radix": 10
            }
          }
        ]
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "IdentExpr",
        "name": "x"
      }
    }
  ]
}
```

## Accepted

A type parameter may stand anywhere in the parameter list. Written out, its argument stands in the same place.

```ents
func at(xs: []T, comptime T: type, i: u32) -> T => xs.ptr[i]

export func a(xs: []u16) -> u16 => at(xs, 2)
export func b(xs: []u8) -> u8 => at(xs, u8, 2)
```

A struct literal is an untyped literal: it takes the type the parameter turns out to have.

```ents
type Pt = (q: i32, r: i32)
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }

export func a(c: bool, p: Pt) -> Pt => pick(c, p, (q: 0, r: 0))
export func b(c: bool) -> Pt => pick(Pt, c, (1, 2), (q: 3, r: 4))
```

A generic used only by a test.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

test "max" {
  assert max(i64, -1, 5) == 5
}
```

A generic with a broken body that nobody calls: its body is not checked.

```ents
func unused(comptime T: type, x: T) -> T => nothing(x)

export func f() -> u32 => 1
```

A local named like a primitive does not change what a type argument means.

```ents
func head(comptime T: type, xs: []T) -> T => xs.ptr[0]

export func f(xs: []u8) -> u8 {
  let u8: u8 = 3
  return head(u8, xs) + u8
}
```

An exported generic. Nothing is exported to the host for it.

```ents
export func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
```

## Rejected at the declaration

Each of these is one mistake and one error.

A comptime value parameter.

```ents
func f(comptime n: u32) -> u32 => n
```

```errors
comptime value parameters are not supported yet: 'n' must be 'type' or a function type
```

An array size that names a comptime value parameter is not parsed at all.

```ents
func zeros(comptime n: u32) -> [n]u8 => 0
```

```errors
Expected
```

A type parameter with a lower-case name.

```ents
func f(comptime t: type) -> u32 => 0
```

```errors
a type parameter's name starts with an upper-case letter: write 'comptime T: type'
```

A type parameter without `comptime`.

```ents
func f(T: type, a: T) -> u32 => 0
```

```errors
a parameter of type 'type' must be comptime: write 'comptime T: type'
```

A parameter without a name.

```ents
func f(comptime T: type, u32) -> u32 => 0
```

```errors
a generic function's parameters need names
```

A generic function without a name.

```ents
func (comptime T: type, a: T) -> T => a
```

```errors
a generic function needs a name
```

A type parameter with the name of a type of the module, declared before or after.

```ents
func f(comptime Pt: type, a: Pt) -> u32 => 0

type Pt = (q: i32, r: i32)
```

```errors
type parameter 'Pt' has the name of a type declared in this module
```

A type parameter declared twice.

```ents
func f(comptime T: type, comptime T: type, a: T) -> u32 => 0
```

```errors
type parameter 'T' is declared twice
```

A generic function declared inside a test. Its calls say nothing more.

```ents
test "local generic" {
  func id(comptime T: type, a: T) -> T => a
  let x: u8 = 1
  assert id(x) == 1
  assert id(u8, 2) == 2
}
```

```errors
a generic function is declared at module level, not inside a test
```

A generic function that shares its name.

```ents
func max(a: u32, b: u32) -> u32 => a

func max(comptime T: type, a: T, b: T) -> T => a
```

```errors
'max' is already declared: a generic function's name is unique in its module
```

A name that a global, a def, a data declaration or an import takes after a generic function has it.

```ents
func count(comptime T: type, a: T) -> T => a

global count: u32 = 0

export func f() -> u32 => count + count(u32, 1)
```

```errors
'count' is already declared: a generic function's name is unique in its module
```

A generic function imported from another source module.

```ents
import "./containers" "max" func max(comptime T: type, a: T, b: T) -> T
```

```errors
generic functions cannot be imported yet
```

A generic function imported from the host.

```ents
import "env" "max" func max(comptime T: type, a: T, b: T) -> T
```

```errors
a host import cannot have comptime parameters
```

## Rejected at the call

The wrong number of arguments. Type parameters are all written or all left out.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f(a: u32) -> u32 => max(a)
```

```errors
'max' expects 2 arguments, or 3 with its type argument written; got 1
```

Named arguments.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f(a: u32) -> u32 => max(a: a, b: 1)
```

```errors
'max' takes positional arguments
```

A type parameter that no argument mentions. The type the call is used as does not decide it.

```ents
func zero(comptime T: type) -> T => 0

func f() -> u32 {
  let x: u32 = zero()
  return x
}
```

```errors
cannot infer T for 'zero': write the type argument, as in zero(u32)
```

Untyped literals only. An array literal is untyped even when one of its elements has a type.

```ents
func count(comptime T: type, xs: []T, x: T) -> u32 => xs.len

func f() -> u32 => count([3:u32, 5, 5], 5)
```

```errors
cannot infer T for 'count' from untyped literals: write count(u32, ...) or give a literal its type
```

A function type is laid over the signature of the function given for it, part by part. Whether the function fits is the ordinary argument check, afterwards: here `T` is found in the result, and `add` is then not a `(u32) -> u32`.

```ents
func add(a: u32, b: u32) -> u32 => a + b
func apply(comptime T: type, f: (T) -> T, x: T) -> T => x

func f() -> u32 => apply(add, 3)
```

```errors
argument 1: cannot assign func(a: u32, b: u32) -> u32 to func(u32) -> u32
```

A value where a type is needed.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f(a: u32) -> u32 => max(a, a, a)
```

```errors
argument 1 of 'max' must be a type: T is a type parameter
```

A type where a value is needed.

```ents
type Pt = (q: i32, r: i32)
func takes(x: f64) -> f64 => x

func f() -> f64 => takes(Pt)
```

```errors
'Pt' is a type; a type can only be passed for a comptime parameter
```

The same for a primitive type. This call is one argument short of the form that writes the type, so it is the form that leaves it out, and `u32` stands where `a` goes.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f(x: u32) -> u32 => max(u32, x)
```

```errors
'u32' is a type; a type can only be passed for a comptime parameter
```

A struct type with named fields, written in place as a type argument. Its field types are not expressions and it is not a function type, so it does not parse; give the type a name with `type` and pass the name.

```ents
type Pt = (q: i32, r: i32)
func size(comptime T: type) -> u32 => sizeof(T)

export func f() -> u32 => size((at: Pt, n: u8))
```

```errors
Expected "->"
```

An argument that has no value.

```ents
func nothing() { }
func id(comptime T: type, a: T) -> T => a

export func f() { id(nothing()) }
```

```errors
argument 1 of 'id' has no value
```

`()` as a type argument.

```ents
type Unit = ()
func id(comptime T: type, a: T) -> T => a

export func f(u: Unit) { id(Unit, u) }
```

```errors
type argument T of 'id' cannot be (): it has no values
```

A type argument that is not a concrete type.

```ents
type Five = int(5)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f() -> i32 => max(Five, 5, 5)
```

```errors
type argument T of 'max' must be a concrete type
```

A later argument that does not fit the type the first one decided.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f(a: u8, b: u32) -> u32 => max(a, b)
```

```errors
argument 2: cannot assign u32 to u8
```

A generic function used as a value.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func takes(x: f64) -> f64 => x

func f() -> f64 => takes(max)
```

```errors
generic function 'max' must be called
```

A failed call says nothing about what its result is used for, nor about its fields.

```ents
type Pt = (q: i32, r: i32)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func takes(x: f64) -> f64 => x

func f() -> f64 => takes(max(1, 2))
func g(a: Pt) -> i32 {
  let p = max(a)
  return p.q + p.r
}
```

```errors
cannot infer T for 'max' from untyped literals: write max(i32, ...) or give a literal its type (1:i32)
'max' expects 2 arguments, or 3 with its type argument written; got 1
```

An argument with an error of its own decides nothing: the call adds no error about the type it would have guessed.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func f(x: u32) -> u32 => max(nope, x)
```

```errors
unknown identifier 'nope'
```

## Rejected in an instance

An error in an instance is reported once, in the generic, with the instance after it.

An operator the type argument does not have.

```ents
type Pt = (q: i32, r: i32)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func f(a: Pt, b: Pt) -> Pt => max(a, b)
export func g(a: Pt, b: Pt) -> Pt => max(Pt, b, a)
```

```errors
'>' cannot be applied to Pt and Pt, in max(T = Pt)
```

A unary operator or a compound assignment the type argument does not have.

```ents
type Pt = (q: i32, r: i32)
func neg(comptime T: type, a: T) -> T => -a
func inv(comptime T: type, a: T) -> T => ~a
func not(comptime T: type, a: T) -> bool => !a
func twice(comptime T: type, a: T) -> T {
  let b = a
  b += a
  return b
}

export func f(p: Pt) -> Pt => twice(inv(neg(p)))
export func g(xs: []u8) -> bool => not(xs)
export func h(x: i32, y: bool) -> bool => not(y) && twice(inv(neg(x))) > 0
```

```errors
'-' needs a number, not Pt, in neg(T = Pt)
'~' needs an integer, not Pt, in inv(T = Pt)
'+=' cannot be applied to Pt and Pt, in twice(T = Pt)
operand of '!' must be bool, not []u8, in not(T = []u8)
```

A literal the type argument cannot hold.

```ents
func over(comptime T: type, x: T) -> bool => x > 300

export func f(x: u8) -> bool => over(x)
export func g(x: u32) -> bool => over(x)
```

```errors
cannot assign int(300) to u8, in over(T = u8)
```

A name that only the caller has. A generic body sees its own module.

```ents
func leak(comptime T: type, x: T) -> T {
  let seen = hidden
  return x
}

export func f() -> u32 {
  let hidden: u32 = 1
  return leak(hidden)
}
```

```errors
unknown identifier 'hidden', in leak(T = u32)
```

Constructing with a type parameter that is not a struct or tuple.

```ents
func make(comptime T: type, x: i32) -> T => T(x)

export func f() -> u32 => make(u32, 1)
```

```errors
u32 is not a struct or tuple type: it has no constructor; to convert a number write x as T, in make(T = u32)
```

A generic that instantiates itself with a larger type each time. It is stopped once, with one error, by whichever comes first: the nesting, the number of instances one call has led to, or the size of the type.

```ents
func deep(comptime T: type, n: u32) -> u32 => if n == 0 { sizeof(T) } else { deep(*T, n - 1) }

export func f() -> u32 => deep(u8, 3)
```

```errors
too many nested instantiations (64) while instantiating 'deep'
```

```ents
func grow(comptime T: type, n: u32) -> u32 => if n == 0 { sizeof(T) } else { grow(*T, n - 1) + grow([]T, n - 1) }

export func f() -> u32 => grow(u8, 3)
```

```errors
too many instantiations (1000) from one call while instantiating 'grow'
```

```ents
func deep(comptime T: type, x: T) -> u32 => deep((T, T), (x, x))

export func f() -> u32 => deep(u8, 1)
```

```errors
type arguments grow without end while instantiating 'deep'
```

## Generic types

A generic type is declared like a function whose result is `type` and whose body is a type. It is a declaration of its own kind, with its parameters and its body.

```ents FuncDecl
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32)
```

```json ast
{
  "kind": "TypeFuncDecl",
  "ident": "Vec",
  "params": [
    {
      "kind": "Field",
      "comptime": true,
      "ident": "T",
      "type": {
        "kind": "TypeType"
      }
    }
  ],
  "body": {
    "kind": "CompositeType",
    "fields": [
      {
        "kind": "Field",
        "ident": "ptr",
        "type": {
          "kind": "IndexedType",
          "element": {
            "kind": "TypeRef",
            "name": "T"
          },
          "size": null,
          "specifiers": [],
          "mutable": true,
          "manyPointer": true
        }
      },
      {
        "kind": "Field",
        "ident": "len",
        "type": {
          "kind": "PrimitiveType",
          "name": "u32"
        }
      }
    ]
  }
}
```

Applied, it is a type: a name and its arguments.

```ents Type
Vec(u32)
```

```json ast
{
  "kind": "TypeApply",
  "name": "Vec",
  "args": [
    {
      "kind": "PrimitiveType",
      "name": "u32"
    }
  ]
}
```

An argument is any type, another application included, and the application stands wherever a type does: behind a pointer, as the element of a slice, of a many-pointer or of an array, in a struct, on either side of a function type.

```ents Type
*mut Vec(T)
```

```json ast
{
  "kind": "PointerType",
  "pointee": {
    "kind": "TypeApply",
    "name": "Vec",
    "args": [
      {
        "kind": "TypeRef",
        "name": "T"
      }
    ]
  },
  "mutable": true
}
```

```ents Type
?*Vec(u8)
```

```json ast
{
  "kind": "PointerType",
  "pointee": {
    "kind": "TypeApply",
    "name": "Vec",
    "args": [
      {
        "kind": "PrimitiveType",
        "name": "u8"
      }
    ]
  },
  "optional": true
}
```

```ents Type
[]Vec(u8)
```

```json ast
{
  "kind": "IndexedType",
  "element": {
    "kind": "TypeApply",
    "name": "Vec",
    "args": [
      {
        "kind": "PrimitiveType",
        "name": "u8"
      }
    ]
  },
  "size": null,
  "specifiers": []
}
```

```ents Type
[*]mut Pair(u8, u16)
```

```json ast
{
  "kind": "IndexedType",
  "element": {
    "kind": "TypeApply",
    "name": "Pair",
    "args": [
      {
        "kind": "PrimitiveType",
        "name": "u8"
      },
      {
        "kind": "PrimitiveType",
        "name": "u16"
      }
    ]
  },
  "size": null,
  "specifiers": [],
  "mutable": true,
  "manyPointer": true
}
```

```ents Type
[4]Pair(u8, u16)
```

```json ast
{
  "kind": "IndexedType",
  "element": {
    "kind": "TypeApply",
    "name": "Pair",
    "args": [
      {
        "kind": "PrimitiveType",
        "name": "u8"
      },
      {
        "kind": "PrimitiveType",
        "name": "u16"
      }
    ]
  },
  "size": 4,
  "specifiers": []
}
```

```ents Type
Map(K, Vec(V))
```

```json ast
{
  "kind": "TypeApply",
  "name": "Map",
  "args": [
    {
      "kind": "TypeRef",
      "name": "K"
    },
    {
      "kind": "TypeApply",
      "name": "Vec",
      "args": [
        {
          "kind": "TypeRef",
          "name": "V"
        }
      ]
    }
  ]
}
```

```ents Type
(first: Vec(u8), second: u32)
```

```json ast
{
  "kind": "CompositeType",
  "fields": [
    {
      "kind": "Field",
      "ident": "first",
      "type": {
        "kind": "TypeApply",
        "name": "Vec",
        "args": [
          {
            "kind": "PrimitiveType",
            "name": "u8"
          }
        ]
      }
    },
    {
      "kind": "Field",
      "ident": "second",
      "type": {
        "kind": "PrimitiveType",
        "name": "u32"
      }
    }
  ]
}
```

```ents Type
Vec(u8) -> Pair(u8, u8)
```

```json ast
{
  "kind": "FuncType",
  "input": {
    "kind": "TypeApply",
    "name": "Vec",
    "args": [
      {
        "kind": "PrimitiveType",
        "name": "u8"
      }
    ]
  },
  "output": {
    "kind": "TypeApply",
    "name": "Pair",
    "args": [
      {
        "kind": "PrimitiveType",
        "name": "u8"
      },
      {
        "kind": "PrimitiveType",
        "name": "u8"
      }
    ]
  }
}
```

There is no space between the name and the parenthesis: a type can end a line, and the next line can start with a parenthesis.

```ents
func f(v: Vec (u32)) -> u32 => 0
```

```errors
Expected
```

As a call argument it is an expression, a call inside the call, which the checker reads as a type where the parameter is one. So is the type that is called to construct a value.

```ents Expr
first(Vec(u32), Pair(A, B)(1, 2))
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "IdentExpr",
    "name": "first"
  },
  "args": [
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "CallExpr",
        "callee": {
          "kind": "IdentExpr",
          "name": "Vec"
        },
        "args": [
          {
            "kind": "Arg",
            "name": null,
            "value": {
              "kind": "IdentExpr",
              "name": "u32"
            }
          }
        ]
      }
    },
    {
      "kind": "Arg",
      "name": null,
      "value": {
        "kind": "CallExpr",
        "callee": {
          "kind": "CallExpr",
          "callee": {
            "kind": "IdentExpr",
            "name": "Pair"
          },
          "args": [
            {
              "kind": "Arg",
              "name": null,
              "value": {
                "kind": "TypeExpr",
                "type": {
                  "kind": "TypeRef",
                  "name": "A"
                }
              }
            },
            {
              "kind": "Arg",
              "name": null,
              "value": {
                "kind": "TypeExpr",
                "type": {
                  "kind": "TypeRef",
                  "name": "B"
                }
              }
            }
          ]
        },
        "args": [
          {
            "kind": "Arg",
            "name": null,
            "value": {
              "kind": "LiteralExpr",
              "value": {
                "kind": "int",
                "value": "1",
                "radix": 10
              }
            }
          },
          {
            "kind": "Arg",
            "name": null,
            "value": {
              "kind": "LiteralExpr",
              "value": {
                "kind": "int",
                "value": "2",
                "radix": 10
              }
            }
          }
        ]
      }
    }
  ]
}
```

### Accepted

A generic type is its body. A struct written out with the same fields, another generic type with the same body and a `type` that names either are the same type, and a generic instantiated for them is one function.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func Stack(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
type Bytes = Vec(u8)

func last(comptime T: type, v: *Vec(T)) -> T => v.ptr[v.len - 1]

export func a(v: *Vec(u8)) -> u8 => last(v)
export func b(v: *Stack(u8)) -> u8 => last(v)
export func c(v: *Bytes) -> u8 => last(v)
export func d(v: *(ptr: [*]mut u8, len: u32, cap: u32)) -> u8 => last(u8, v)
```

```ents same-wasm
type Bytes = (ptr: [*]mut u8, len: u32, cap: u32)

func last_u8(v: *Bytes) -> u8 => v.ptr[v.len - 1]

export func a(v: *Bytes) -> u8 => last_u8(v)
export func b(v: *Bytes) -> u8 => last_u8(v)
export func c(v: *Bytes) -> u8 => last_u8(v)
export func d(v: *Bytes) -> u8 => last_u8(v)
```

Declared after its uses, and applied in the body of another.

```ents
export func f(m: *Map(u8, f64), i: u32) -> f64 => m.vals[i].second

func Map(comptime K: type, comptime V: type) -> type => (keys: [*]mut K, vals: [*]mut Pair(K, V), n: u32)
func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)
```

A type may refer to itself through a `type`, as any type may. The generic type applies nothing here.

```ents
type Node = Link(u32)
func Link(comptime T: type) -> type => (head: T, next: ?*Node)

export func second(n: *Node) -> u32 => if let m = n.next { m.head } else { 0 }
```

Type parameters are found through a generic type by its body, at any depth, and through two at once.

```ents
func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)
func Map(comptime K: type, comptime V: type) -> type => (keys: [*]mut K, vals: [*]mut Pair(K, V), n: u32)

func val(comptime K: type, comptime V: type, m: *Map(K, V), i: u32) -> V => m.vals[i].second
func swapped(comptime A: type, comptime B: type, p: Pair(A, B)) -> Pair(B, A) => Pair(B, A)(p.second, p.first)

export func a(m: *Map(u8, f64)) -> f64 => val(m, 2)
export func b(p: (first: i32, second: f32)) -> f32 => swapped(swapped(swapped(p))).first

test "swapped three times is swapped once" {
  assert b((first: 1, second: 2.5)) == 2.5
}
```

A type that is called constructs a value: by position, by name in any order, with `T(...)` where `T` is a struct or a tuple in the instance, and with a tuple of types.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
type Pt = (q: i32, r: i32)

func make(comptime T: type, x: i32) -> T => T(x, x + 1)
func named(comptime T: type, x: i32) -> T => T(r: x, q: x + 1)
func empty(comptime T: type) -> Vec(T) => Vec(T)(cap: 4, ptr: 0 as [*]mut T, len: 0)
func three(comptime T: type, x: T) -> (T, T, T) => (T, T, T)(x, x, x)

test "constructors" {
  assert make(Pt, 10).r == 11
  assert make((i32, i32), 20).0 == 20
  assert named(Pt, 10).q == 11
  assert empty(u8).cap == 4
  assert three(7:u32).2 == 7
}
```

In a data literal and in a global's initializer it is data, as the constructor of a `type` is.

```ents
func Pair(comptime A: type, comptime B: type) -> type => (first: A, second: B)

global origin: Pair(i32, f64) = Pair(i32, f64)(1, 2.5)
data table = [Pair(u8, u16)(1, 2), Pair(u8, u16)(3, 4)]

test "data" {
  assert origin.second == 2.5
  assert (table as [*]Pair(u8, u16))[1].second == 4
}
```

A struct type with named fields cannot be written in place as a type argument when its field types are not expressions. A generic type names it, also where it mentions a type parameter of the generic the call is in, which a `type` cannot.

```ents
func Named(comptime A: type, comptime B: type) -> type => (name: A, at: B)
type Pt = (q: i32, r: i32)

func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
func id(comptime T: type, v: T) -> T => v
func wrap(comptime T: type, x: T) -> u32 => id(Named(T, u8), (name: x, at: 2)).at

export func a(c: bool, n: []u8, p: Pt) -> u32 => pick(Named([]u8, Pt), c, (name: n, at: p), (name: n, at: p)).name.len
export func b() -> u32 => wrap(7:u64)
```

An exported generic type gives the host nothing, and one that is never applied is only parsed.

```ents
export func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func Unused(comptime T: type) -> type => (t: T, n: Nope)

export func f(a: u32) -> u32 => a + 1
```

```ents same-wasm
export func f(a: u32) -> u32 => a + 1
```

### Rejected where it is declared

Each of these is one mistake and one error.

A parameter that is not a comptime type parameter, and no parameters at all.

```ents
func Vec(comptime T: type, n: u32) -> type => (T, u32)

func f(v: Vec(u32)) -> u32 => 0
```

```errors
generic type 'Vec' takes comptime type parameters only, as (comptime T: type)
```

```ents
func Unit() -> type => u32
```

```errors
generic type 'Unit' takes comptime type parameters only, as (comptime T: type)
```

A block body. The body of a generic type is one type.

```ents
func Vec(comptime T: type) -> type { }
```

```errors
Expected "=>"
```

A generic type that applies itself, and two that apply each other: one error for the round.

```ents
func List(comptime T: type) -> type => (head: T, next: ?*List(T))

func f(a: *List(u32), b: *List(u8)) -> u32 => 0
```

```errors
generic type 'List' refers to itself
```

```ents
func A(comptime T: type) -> type => (x: T, b: *B(T))
func B(comptime T: type) -> type => (y: T, a: *A(T))

func f(a: *A(u32), b: *B(u8)) -> u32 => 0
```

```errors
generic type 'A' refers to itself
```

A type parameter that is applied, in a generic type and in a generic function.

```ents
func Bad(comptime F: type) -> type => (x: F(u32))
```

```errors
a type parameter cannot be applied
```

```ents
func bad(comptime F: type, x: F(u32)) -> u32 => 0

func f() -> u32 => bad(u32, 1)
```

```errors
a type parameter cannot be applied
```

A type parameter declared twice, or named like a type of the module.

```ents
func Two(comptime A: type, comptime A: type) -> type => (A, A)
```

```errors
type parameter 'A' is declared twice
```

```ents
type Pt = (q: i32, r: i32)
func Two(comptime Pt: type) -> type => (Pt, Pt)
```

```errors
type parameter 'Pt' has the name of a type declared in this module
```

A name that a `type` or another generic type has.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
type Vec = (a: u32)

func f(v: *Vec(u32), w: Vec) -> u32 => v.len
```

```errors
'Vec' is already declared: a generic type's name is unique in its module
```

Inside a test.

```ents
test "t" {
  func Two(comptime T: type) -> type => (T, T)
  let v: Two(u32) = (1, 2)
  assert v.0 == 1
}
```

```errors
a generic type is declared at module level, not inside a test
```

### Rejected where it is applied

Without its arguments.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(v: *Vec) -> u32 => 0
```

```errors
'Vec' is a generic type: write Vec(T)
```

With the wrong number of them.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(v: *Vec(u32, u8)) -> u32 => 0
```

```errors
Vec expects 1 type argument, got 2
```

A type that is not generic, and a name that is no type.

```ents
type Point = (x: i32, y: i32)

func f(v: *Point(u32)) -> u32 => 0
```

```errors
'Point' is not a generic type
```

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(v: *Vex(u32)) -> u32 => 0
```

```errors
unknown generic type 'Vex' — did you mean 'Vec'?
```

An argument that is not a concrete type.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(v: *Vec(int(5))) -> u32 => 0
```

```errors
type argument T of 'Vec' must be a concrete type
```

In the declaration of a generic function these are found where it is declared, once, whatever its calls are.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func last(comptime T: type, v: *Vec(T, T)) -> T => v.ptr[v.len - 1]

export func a(v: *Vec(u8)) -> u8 => last(v)
export func b(v: *Vec(u16)) -> u16 => last(u16, v)
```

```errors
Vec expects 1 type argument, got 2
```

Different arguments are different types.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(a: *Vec(u8)) -> u32 {
  let b: *Vec(u32) = a
  return b.len
}
```

```errors
cannot assign *Vec(u8) to *Vec(u32)
```

A type parameter that the generic type has no field of cannot be found through it.

```ents
func Tagged(comptime T: type) -> type => (id: u32)
func tag(comptime T: type, t: Tagged(T)) -> u32 => t.id + sizeof(T)

func f(t: Tagged(u8)) -> u32 => tag(t)
```

```errors
cannot infer T for 'tag': 'Tagged(T)' does not use T in its fields; write the type argument
```

Where a value is expected: applied, it is a type; called without its type arguments, it is not yet one.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f() -> u32 {
  let v = Vec(u32)
  return 0
}
```

```errors
'Vec(u32)' is a type; a type can only be passed for a comptime parameter
```

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(p: [*]mut u32) -> u32 {
  let v = Vec(p, 0, 4)
  return 0
}
```

```errors
'Vec' is a generic type: write Vec(T)
```

The arguments of a constructor are checked as those of any constructor, and a field is given once.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(p: [*]mut u32) -> u32 => Vec(u32)(p, 0).len
```

```errors
Vec(u32) expects 3 fields, got 2
```

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func f(p: [*]mut u32) -> u32 => Vec(u32)(ptr: p, len: 0, ptr: p).len
```

```errors
Vec(u32): field 'ptr' is given twice
```

## Comptime function parameters

A comptime parameter of a function type is a field with `comptime` set, like a type parameter.

```ents FuncDecl
func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
```

```json ast
{
  "kind": "FuncDecl",
  "inline": false,
  "ident": "apply",
  "signature": {
    "kind": "FuncSignature",
    "input": {
      "kind": "CompositeType",
      "fields": [
        {
          "kind": "Field",
          "comptime": true,
          "ident": "f",
          "type": {
            "kind": "FuncType",
            "input": {
              "kind": "CompositeType",
              "fields": [
                {
                  "kind": "Field",
                  "ident": null,
                  "type": {
                    "kind": "PrimitiveType",
                    "name": "u32"
                  }
                }
              ]
            },
            "output": {
              "kind": "PrimitiveType",
              "name": "u32"
            }
          }
        },
        {
          "kind": "Field",
          "ident": "x",
          "type": {
            "kind": "PrimitiveType",
            "name": "u32"
          }
        }
      ]
    },
    "output": {
      "kind": "PrimitiveType",
      "name": "u32"
    }
  },
  "body": {
    "kind": "ArrowBody",
    "expr": {
      "kind": "CallExpr",
      "callee": {
        "kind": "IdentExpr",
        "name": "f"
      },
      "args": [
        {
          "kind": "Arg",
          "name": null,
          "value": {
            "kind": "IdentExpr",
            "name": "x"
          }
        }
      ]
    }
  }
}
```

### Accepted

A call of the parameter is a direct call of the function it was given. Each function makes its own instance, and the module is the one with the copies written out.

```ents
func apply(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func inc(x: u32) -> u32 => x + 1
func dec(x: u32) -> u32 => x - 1

export func up(x: u32) -> u32 => apply(inc, x)
export func down(x: u32) -> u32 => apply(u32, dec, x)

test "twice" {
  assert up(5) == 7
  assert down(5) == 3
}
```

```ents same-wasm
func apply_dec(x: u32) -> u32 => dec(dec(x))
func apply_inc(x: u32) -> u32 => inc(inc(x))
func inc(x: u32) -> u32 => x + 1
func dec(x: u32) -> u32 => x - 1

export func up(x: u32) -> u32 => apply_inc(x)
export func down(x: u32) -> u32 => apply_dec(x)
```

Passed on to another generic, by its parameter's name.

```ents
func each(comptime T: type, xs: []T, comptime f: (T) -> T) -> T => f(xs.ptr[0])
func both(comptime T: type, xs: []T, comptime g: (T) -> T) -> T => each(xs, g) + each(T, xs, g)
func inc(x: u32) -> u32 => x + 1

data nums = [10:u32, 20]

test "passed on" {
  assert both(nums, inc) == 22
}
```

An imported function, and a generic with no type parameter at all.

```ents
import "env" "before" func before(a: i32, b: i32) -> bool

func first(comptime cmp: (i32, i32) -> bool, a: i32, b: i32) -> i32 => if cmp(a, b) { a } else { b }

export func f(a: i32, b: i32) -> i32 => first(before, a, b)
```

### Rejected

An argument that is not the name of a function: a value, an expression, a generic.

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }

func f(xs: []mut i32) { sort(i32, xs, 5) }
```

```errors
argument 3 of 'sort' must be the name of a function: before is a comptime function parameter
```

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }
func less(comptime T: type, a: T, b: T) -> bool => a < b

func f(xs: []mut i32) { sort(xs, less) }
```

```errors
argument 2 of 'sort' must be the name of a function: before is a comptime function parameter
```

A function of another signature.

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }
func inc(x: u32) -> u32 => x + 1

func f(xs: []mut i32) { sort(xs, inc) }
```

```errors
'inc' is (u32) -> u32, but 'sort' needs before: (i32, i32) -> bool
```

A function that lists a struct's fields as its results is one that returns the struct; results without the fields' names are not.

```ents
func Acc(comptime T: type) -> type => (sum: T, n: u32)
func step(comptime T: type, comptime f: (Acc(T), T) -> Acc(T), a: Acc(T), x: T) -> Acc(T) => f(a, x)
func add(a: Acc(f64), x: f64) -> (sum: f64, n: u32) => (a.sum + x, a.n + 1)

export func one(x: f64) -> u32 => step(add, Acc(f64)(0.0, 0), x).n

test "the listed results are the struct" {
  assert one(2.5) == 1
}
```

```ents
func Acc(comptime T: type) -> type => (sum: T, n: u32)
func step(comptime T: type, comptime f: (Acc(T), T) -> Acc(T), a: Acc(T), x: T) -> Acc(T) => f(a, x)
func add(a: Acc(f64), x: f64) -> (f64, u32) => (a.sum + x, a.n + 1)

func one(x: f64) -> u32 => step(add, Acc(f64)(0.0, 0), x).n
```

```errors
'add' is (Acc(f64), f64) -> (f64, u32), but 'step' needs f: (Acc(f64), f64) -> Acc(f64)
```

A function that a test declares is no function of the module.

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }
data space = mut [0:u8; 64]

test "t" {
  func by_low_bits(a: i32, b: i32) -> bool => (a & 7) < (b & 7)
  sort((space as [*]mut i32)[0..4], by_low_bits)
}
```

```errors
argument 2 of 'sort' must be a function declared at module level: 'by_low_bits' is declared inside a test
```

Also when it has the name of a function of the module: inside the test the name is the test's function.

```ents
func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func helper(x: u32) -> u32 => x + 1

test "t" {
  func helper(x: u32) -> u32 => x + 10
  assert twice(helper, 1) == 21
}
```

```errors
argument 1 of 'twice' must be a function declared at module level: 'helper' is declared inside a test
```

The parameter used as a value.

```ents
func keep(comptime T: type, x: T, comptime f: (T) -> T) -> T {
  let g = f
  return f(x)
}
func inc(x: u32) -> u32 => x + 1

export func a() -> u32 => keep(1:u32, inc)
```

```errors
'f' is a comptime function parameter: it can only be called, or passed on for a comptime function parameter, in keep(T = u32, f = inc)
```

A parameter of the same name.

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool, before: u32) { }
```

```errors
parameter 'before' is declared twice
```

Too few arguments for a generic that has no type parameter to leave out.

```ents
func apply(comptime f: (u32) -> u32, x: u32) -> u32 => f(x)
func inc(x: u32) -> u32 => x + 1

func g() -> u32 => apply(inc)
```

```errors
'apply' expects 2 arguments, got 1
```

<!-- spec:end -->
