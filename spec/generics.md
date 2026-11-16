# Generics

Generic functions: a function with a compile-time type parameter, compiled once for each type it is used with. The rules are the "Generics" chapter of [`docs/encantis.md`](../docs/encantis.md), whose own examples are run as tests too. This file holds the cases that are too detailed for the reference: how the new forms parse, programs at the edges of what is accepted, and one case for every error.

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

A call in a global's initializer instantiates like any other.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

global limit: u32 = max(u32, 3, 4)
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

A comptime function parameter.

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }
```

```errors
comptime parameter 'before' must be a type parameter: comptime function parameters are not supported yet
```

A comptime value parameter.

```ents
func f(comptime n: u32) -> u32 => n
```

```errors
comptime value parameters are not supported yet: 'n' must be 'type' or a function type
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

A generic function declared inside a test.

```ents
test "local generic" {
  func id(comptime T: type, a: T) -> T => a
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

A failed call says nothing about what its result is used for.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func takes(x: f64) -> f64 => x

func f() -> f64 => takes(max(1, 2))
```

```errors
cannot infer T for 'max' from untyped literals: write max(i32, ...) or give a literal its type (1:i32)
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
operator > is not defined for Pt, in max(T = Pt)
```

A literal the type argument cannot hold.

```ents
func positive(comptime T: type, x: T) -> bool => x > 0

export func f(x: f64) -> bool => positive(x)
```

```errors
cannot assign int(0) to f64, in positive(T = f64)
```

A name that only the caller has. A generic body sees its own module.

```ents
func leak(comptime T: type, x: T) -> T => x + hidden

export func f() -> u32 {
  let hidden: u32 = 1
  return leak(hidden)
}
```

```errors
unknown identifier 'hidden', in leak(T = u32)
```

Constructing with a type parameter.

```ents
func make(comptime T: type, x: i32) -> T => T(x, x)

export func f() -> (i32, i32) => make((i32, i32), 1)
```

```errors
T(...) on a type parameter is not supported yet, in make(T = (i32, i32))
```

A generic that instantiates itself with a larger type each time.

```ents
func deep(comptime T: type, x: T) -> u32 => deep((T, T), (x, x))

export func f() -> u32 => deep(u8, 1)
```

```errors
too many nested instantiations (64) while instantiating 'deep'
```
