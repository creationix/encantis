# Generics

Generic functions: a function with a compile-time type parameter, compiled once for each type it is used with. Generic types, a type with type parameters, comptime function parameters, method calls and the calls a generic's body makes have their own sections at the end. The rules are the "Generics" chapter of [`docs/encantis.md`](../docs/encantis.md), whose own examples are run as tests too. This file holds the cases that are too detailed for the reference: how the new forms parse, programs at the edges of what is accepted, and one case for every error.

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

A tuple decides by its typed parts: here `i` decides `T` wherever it stands, also in a tuple inside the tuple, and the literals take the type `T` turns out to be. The literals by themselves decide nothing (see the errors below).

```ents
func keep(comptime T: type, p: (T, T)) -> T => p.0
func deep(comptime T: type, p: ((T, u8), T)) -> T => p.1

export func a(i: u32) -> u32 => keep((i, 1)) + keep((2, i))
export func b(i: u16) -> u16 => deep(((1, 2), i)) + deep(((i, 2), 3))
```

```ents same-wasm
func keep(comptime T: type, p: (T, T)) -> T => p.0
func deep(comptime T: type, p: ((T, u8), T)) -> T => p.1

export func a(i: u32) -> u32 => keep(u32, (i, 1)) + keep(u32, (2, i))
export func b(i: u16) -> u16 => deep(u16, ((1, 2), i)) + deep(u16, ((i, 2), 3))
```

A struct type with named fields is written in place as a type argument as it is after a colon, also where its field types are not expressions (`[]u8`, `Pt`, `?*Pt`) and where it has one field. It is the type a `type` of it names, and compiles to the same module.

```ents
type Pt = (q: i32, r: i32)
func size(comptime T: type) -> u32 => sizeof(T)
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }

export func f() -> u32 => size((at: Pt, n: u8)) + size((at: Pt)) + size((p: ?*Pt))
export func g(c: bool, s: []u8, p: Pt) -> i32 => pick((name: []u8, at: Pt), c, (name: s, at: p), (name: "b", at: p)).at.r
```

```ents same-wasm
type Pt = (q: i32, r: i32)
type Two = (at: Pt, n: u8)
type One = (at: Pt)
type Ref = (p: ?*Pt)
type Named = (name: []u8, at: Pt)
func size(comptime T: type) -> u32 => sizeof(T)
func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }

export func f() -> u32 => size(Two) + size(One) + size(Ref)
export func g(c: bool, s: []u8, p: Pt) -> i32 => pick(Named, c, (name: s, at: p), (name: "b", at: p)).at.r
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

A table works the same in a generic. Matched against `*[2][3]i32`, `*[2][3]T` binds `T` to `i32` and `*[2]R` binds `R` to `[3]i32`; either way the parameter is a table, each element a pointer to its row, and the instance is the function written out for it.

```ents
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
data board: *mut [2][3]u8 = mut [[0; 3]; 2]

func cell(comptime T: type, m: *[2][3]T, i: u32#2, j: u32#3) -> T => m[i][j]
func put(comptime T: type, m: *mut [2][3]T, i: u32#2, j: u32#3, v: T) {
  m[i][j] = v
}
func row(comptime R: type, m: *[2]R, i: u32) -> *R => if let r = m[i] { r } else { m[0] }
func cells(comptime R: type, m: *[2]R) -> u32 {
  let n: u32 = 0
  for r in m {
    n += r.len
  }
  return n * m.wid
}

export func a(i: u32#2, j: u32#3) -> i32 => cell(i32, grid, i, j)
export func b(i: u32#2, j: u32#3, v: u8) {
  put(board, i, j, v)
}
export func c(i: u32) -> *[3]i32 => row(grid, i)
export func d() -> u32 => cells(grid)

test "a table in a generic" {
  b(1, 2, 9)
  assert board[1][2] == 9
  assert a(1, 2) == 5
  assert c(1)[0] == 3
  assert c(7) == grid[0]
  assert d() == 24
}
```

```ents same-wasm
data grid: *[2][3]i32 = [[7, 1, 2], [3, 4, 5]]
data board: *mut [2][3]u8 = mut [[0; 3]; 2]

func cell_i32(m: *[2][3]i32, i: u32#2, j: u32#3) -> i32 => m[i][j]
func put_u8(m: *mut [2][3]u8, i: u32#2, j: u32#3, v: u8) {
  m[i][j] = v
}
func row_i32x3(m: *[2][3]i32, i: u32) -> *[3]i32 => if let r = m[i] { r } else { m[0] }
func cells_i32x3(m: *[2][3]i32) -> u32 {
  let n: u32 = 0
  for r in m {
    n += r.len
  }
  return n * m.wid
}

export func a(i: u32#2, j: u32#3) -> i32 => cell_i32(grid, i, j)
export func b(i: u32#2, j: u32#3, v: u8) {
  put_u8(board, i, j, v)
}
export func c(i: u32) -> *[3]i32 => row_i32x3(grid, i)
export func d() -> u32 => cells_i32x3(grid)
```

So does a slice of rows: `[]R` with `R = [2]i32` is a `[][2]i32`, whose elements are row pointers.

```ents
data rows: [][2]i32 = [[7, 1], [3, 4], [5, 6]]

func at(comptime T: type, s: [][2]T, i: u32, j: u32#2) -> T => if let r = s[i] { r[j] } else { 0 }
func sum(comptime R: type, s: []R) -> i32 {
  let t = 0
  for r in s {
    t += r[0] * r[1]
  }
  return t
}

export func e(i: u32, j: u32#2) -> i32 => at(rows, i, j)
export func f() -> i32 => sum(rows)

test "a slice of rows in a generic" {
  assert e(2, 1) == 6
  assert e(3, 0) == 0
  assert f() == 49
}
```

```ents same-wasm
data rows: [][2]i32 = [[7, 1], [3, 4], [5, 6]]

func at_i32(s: [][2]i32, i: u32, j: u32#2) -> i32 => if let r = s[i] { r[j] } else { 0 }
func sum_i32x2(s: [][2]i32) -> i32 {
  let t = 0
  for r in s {
    t += r[0] * r[1]
  }
  return t
}

export func e(i: u32, j: u32#2) -> i32 => at_i32(rows, i, j)
export func f() -> i32 => sum_i32x2(rows)
```

A string with no type to meet is laid out at the end of the function it is in, in an instance as in the same function written by hand; a `mut` one is a copy for each instance.

```ents
data other = "zz"
func tag(comptime T: type, x: T) -> u8 {
  let s = "ab"
  let t = mut "cd"
  t[0] = s[1]
  return t[0]
}
export func f() -> u8 => tag(u8, 1) + tag(u32, 2)
export func g() -> []u8 => "tail"

test "strings in a generic" {
  assert f() == 196
}
```

```ents same-wasm
data other = "zz"
func tag_u32(x: u32) -> u8 {
  let s = "ab"
  let t = mut "cd"
  t[0] = s[1]
  return t[0]
}
func tag_u8(x: u8) -> u8 {
  let s = "ab"
  let t = mut "cd"
  t[0] = s[1]
  return t[0]
}
export func f() -> u8 => tag_u8(1) + tag_u32(2)
export func g() -> []u8 => "tail"
```

An exported generic. Nothing is exported to the host for it.

```ents
export func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
```

## Rejected at the declaration

Each of these is one mistake and one error.

A comptime parameter of a float type. A comptime parameter is a type, an integer or a function.

```ents
func f(comptime r: f64) -> u32 => 0
```

```errors
comptime parameter 'r' is f64: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)
```

A `bool` is no value parameter: with no compile-time `if`, it would choose nothing.

```ents
func f(comptime ok: bool) -> u32 => 0
```

```errors
comptime parameter 'ok' is bool: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)
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

Untyped literals only, also as the parts of a tuple.

```ents
func keep(comptime T: type, p: (T, T)) -> T => p.0

func f() -> u32 => keep((1, 2))
```

```errors
cannot infer T for 'keep' from untyped literals: write keep(i32, ...) or give a literal its type
```

An array literal is untyped even when one of its elements has a type.

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

A fixed array for `T` makes `[*]T`, `[]T` and `*[N]T` tables (reference 2.5): an element is a pointer to its row, not a `T`, so an instance that uses one as a `T` is refused. The error has a note that names the rule and the two ways round it: a struct with an array field, `(cells: [3]i32)`, for rows packed in place, or `*[3]i32` for pointers to rows (see Generic types, Accepted).

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]

export func f(v: *Vec([3]i32)) -> i32 => get(v, 1)[2]
export func g(v: *Vec(u32)) -> u32 => get(v, 1)
```

```errors
cannot assign *mut [3]i32 to [3]i32, in get(T = [3]i32)
```

Bytes counted with `sizeof(T)` are the rows, not a table of them. A table's bytes are its row pointers, so `memcpy` checks a length against those, and `memzero`, which would point every row at address 0, is refused. The same code is right for a `T` that is no fixed array.

```ents
data a: *mut [2][3]i32 = mut [[1, 2, 3], [4, 5, 6]]
data b: *[2][3]i32 = [[7, 8, 9], [10, 11, 12]]
data n: *mut [2]u32 = mut [1, 2]

func copy(comptime T: type, d: *mut [2]T, s: *[2]T) {
  memcpy(d, s, 2 * sizeof(T))
}
func clear(comptime T: type, p: *mut [2]T) {
  memzero(p)
}

export func f() {
  copy(a, b)
  clear(a)
}
export func g() {
  copy(n, n)
  clear(n)
}
```

```errors
memcpy length 24 exceeds buffer size 8 bytes, in copy(T = [3]i32)
memzero dest: *mut [2][3]i32 is a table, its elements pointers to rows (reference 2.5): zero each row, for row in p { memzero(row) }, in clear(T = [3]i32)
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

So may a generic type itself, directly or through another, through a pointer or a slice: inside its body the same application is the type being made. It costs what the type written out does.

```ents
func List(comptime T: type) -> type => (head: T, next: ?*List(T))
func Even(comptime T: type) -> type => (odd: []Odd(T), v: T)
func Odd(comptime T: type) -> type => (even: ?*Even(T), v: T)

export func third(l: *List(u16)) -> u16 => if let a = l.next { if let b = a.next { b.head } else { 0 } } else { 0 }
export func hop(e: Even(u8)) -> u8 => if let o = e.odd[0] { if let f = o.even { f.v } else { o.v } } else { e.v }
```

```ents same-wasm
type List16 = (head: u16, next: ?*List16)
type Even8 = (odd: []Odd8, v: u8)
type Odd8 = (even: ?*Even8, v: u8)

export func third(l: *List16) -> u16 => if let a = l.next { if let b = a.next { b.head } else { 0 } } else { 0 }
export func hop(e: Even8) -> u8 => if let o = e.odd[0] { if let f = o.even { f.v } else { o.v } } else { e.v }
```

A generic type whose body is a pointer, a slice, an array or an optional is that type, as a `type` that names one is: `.*`, `.len`, indexing, `if let` and `??` see through it.

```ents
func Ref(comptime T: type) -> type => *mut T
func Sl(comptime T: type) -> type => []T
func Four(comptime T: type) -> type => [4]T
func Maybe(comptime T: type) -> type => ?*T

func swap(comptime T: type, a: Ref(T), b: Ref(T)) {
  let t = a.*
  a.* = b.*
  b.* = t
}
func last(comptime T: type, s: Sl(T)) -> T => s[s.len - 1] ?? 0
export func f(a: Ref(u32), b: Ref(u32), s: Sl(i16), x: Four(u8), o: Maybe(u64)) -> u64 {
  swap(a, b)
  return a.* as u64 + last(s) as u64 + x[3] as u64 + (if let q = o { q.* } else { 0 })
}
```

```ents same-wasm
func swap(a: *mut u32, b: *mut u32) {
  let t = a.*
  a.* = b.*
  b.* = t
}
func last(s: []i16) -> i16 => s[s.len - 1] ?? 0
export func f(a: *mut u32, b: *mut u32, s: []i16, x: [4]u8, o: ?*u64) -> u64 {
  swap(a, b)
  return a.* as u64 + last(s) as u64 + x[3] as u64 + (if let q = o { q.* } else { 0 })
}
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

A struct type with named fields can be written in place as a type argument, also where it mentions a type parameter of the generic the call is in, which a `type` cannot; a generic type names it too.

```ents
func Named(comptime A: type, comptime B: type) -> type => (name: A, at: B)
type Pt = (q: i32, r: i32)

func pick(comptime T: type, first: bool, a: T, b: T) -> T => if first { a } else { b }
func id(comptime T: type, v: T) -> T => v
func wrap(comptime T: type, x: T) -> u32 => id(Named(T, u8), (name: x, at: 2)).at + id((name: T, at: u8), (name: x, at: 3)).at

export func a(c: bool, n: []u8, p: Pt) -> u32 => pick(Named([]u8, Pt), c, (name: n, at: p), (name: n, at: p)).name.len
export func b() -> u32 => wrap(7:u64)
```

A fixed array for `T` makes `[*]mut T` a table (reference 2.5), whose elements are pointers to rows; a struct with an array field lies in place instead. So a container of rows packed in place is a `Vec` of such a struct: `sizeof(T)` is 12, the stride of `v.ptr` is 12, and growing it by `len * sizeof(T)` bytes copies every row. It compiles to the same module as the container written out for the struct.

```ents
data space = mut [0:u8; 4096]
global top: u32 = 0

func alloc(n: u32) -> (p: u32) {
  top = (top + 7) & 0xFFFFFFF8
  p = (space as u32) + top
  top += n
}

func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func vec(comptime T: type, cap: u32) -> *mut Vec(T) {
  let v = alloc(sizeof(Vec(T))) as *mut Vec(T)
  v.* = Vec(T)(alloc(cap * sizeof(T)) as [*]mut T, 0, cap)
  return v
}

func grow(comptime T: type, v: *mut Vec(T)) {
  let moved = alloc(v.cap * 2 * sizeof(T))
  memcpy(moved as *mut [4096]u8, v.ptr, v.len * sizeof(T))
  v.ptr = moved as [*]mut T
  v.cap *= 2
}

func push(comptime T: type, v: *mut Vec(T), x: T) {
  if v.len == v.cap { grow(v) }
  v.ptr[v.len] = x
  v.len += 1
}

func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]

type Cells = (cells: [3]i32)

export func rows(n: i32) -> i32 {
  let v = vec(Cells, 1)
  push(v, Cells([1, 2, 3]))
  push(v, Cells([4, 5, n]))
  push(v, Cells([7, 8, 9]))
  return get(v, 1).cells[2] + get(v, 2).cells[0] + (v.cap as i32)
}

test "rows packed in place" {
  assert rows(6) == 6 + 7 + 4
  assert sizeof(Cells) == 12
  assert sizeof(Vec(Cells)) == 12
}
```

```ents same-wasm
data space = mut [0:u8; 4096]
global top: u32 = 0

func alloc(n: u32) -> (p: u32) {
  top = (top + 7) & 0xFFFFFFF8
  p = (space as u32) + top
  top += n
}

type Cells = (cells: [3]i32)
type VecCells = (ptr: [*]mut Cells, len: u32, cap: u32)

func vec_cells(cap: u32) -> *mut VecCells {
  let v = alloc(12) as *mut VecCells
  v.* = VecCells(alloc(cap * 12) as [*]mut Cells, 0, cap)
  return v
}

func grow_cells(v: *mut VecCells) {
  let moved = alloc(v.cap * 2 * 12)
  memcpy(moved as *mut [4096]u8, v.ptr, v.len * 12)
  v.ptr = moved as [*]mut Cells
  v.cap *= 2
}

func push_cells(v: *mut VecCells, x: Cells) {
  if v.len == v.cap { grow_cells(v) }
  v.ptr[v.len] = x
  v.len += 1
}

func get_cells(v: *VecCells, i: u32) -> Cells => v.ptr[i]

export func rows(n: i32) -> i32 {
  let v = vec_cells(1)
  push_cells(v, Cells([1, 2, 3]))
  push_cells(v, Cells([4, 5, n]))
  push_cells(v, Cells([7, 8, 9]))
  return get_cells(v, 1).cells[2] + get_cells(v, 2).cells[0] + (v.cap as i32)
}
```

For the rows' addresses, the element is a pointer: `Vec(*[3]i32)` holds pointers to rows that lie elsewhere, 4 bytes each.

```ents
data space = mut [0:u8; 4096]
global top: u32 = 0

func alloc(n: u32) -> (p: u32) {
  top = (top + 7) & 0xFFFFFFF8
  p = (space as u32) + top
  top += n
}

func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)

func vec(comptime T: type, cap: u32) -> *mut Vec(T) {
  let v = alloc(sizeof(Vec(T))) as *mut Vec(T)
  v.* = Vec(T)(alloc(cap * sizeof(T)) as [*]mut T, 0, cap)
  return v
}

func push(comptime T: type, v: *mut Vec(T), x: T) {
  assert v.len < v.cap
  v.ptr[v.len] = x
  v.len += 1
}

func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]

data one: *[3]i32 = [1, 2, 3]
data two: *[3]i32 = [4, 5, 6]

test "pointers to rows" {
  let v = vec(*[3]i32, 2)
  push(v, one)
  push(v, two)
  assert get(v, 1)[2] == 6
  assert get(v, 0) == one
  assert sizeof(*[3]i32) == 4
}
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

A parameter that is not comptime, and no parameters at all.

```ents
func Vec(comptime T: type, n: u32) -> type => (T, u32)

func f(v: Vec(u32)) -> u32 => 0
```

```errors
generic type 'Vec' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)
```

```ents
func Unit() -> type => u32
```

```errors
generic type 'Unit' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)
```

A block body. The body of a generic type is one type.

```ents
func Vec(comptime T: type) -> type { }
```

```errors
Expected "=>"
```

A generic type that applies itself, or two that apply each other, to a type made of their parameters: one error for the round. Applying them would make a new type at every level.

```ents
func List(comptime T: type) -> type => (head: T, next: ?*List(*T))

func f(a: *List(u32), b: *List(u8)) -> u32 => 0
```

```errors
generic type 'List' refers to itself with a type argument that grows, List(*T): applying it would never end
```

```ents
func A(comptime T: type) -> type => (x: T, b: *B([]T))
func B(comptime T: type) -> type => (y: T, a: *A(T))

func f(a: *A(u32), b: *B(u8)) -> u32 => 0
```

```errors
generic type 'A' refers to itself with a type argument that grows, B([]T): applying it would never end
```

One that holds itself, not through a pointer or a slice, has no size, whatever its arguments are: one error, where it is declared.

```ents
func List(comptime T: type) -> type => (head: T, next: List(T))

func f(a: *List(u32), b: *List(u8)) -> u32 => 0
```

```errors
generic type 'List' contains itself: a type can only refer to itself through a pointer or a slice
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
Vec(u32) expects 3 fields, got 2: no value for cap
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

A function that a test declares, given in the test: the instance calls it by the name its test gives it, and exists in the test build only. Also when it has the name of a function of the module: inside the test the name is the test's function, and the instance is another one.

```ents
func sort(comptime T: type, xs: []mut T, comptime before: (T, T) -> bool) { }
data space = mut [0:u8; 64]

test "t" {
  func by_low_bits(a: i32, b: i32) -> bool => (a & 7) < (b & 7)
  sort((space as [*]mut i32)[0..4], by_low_bits)
}
```

```ents
func twice(comptime T: type, comptime f: (T) -> T, x: T) -> T => f(f(x))
func helper(x: u32) -> u32 => x + 1

export func go() -> u32 => twice(helper, 1)

test "t" {
  func helper(x: u32) -> u32 => x + 10
  assert twice(helper, 1) == 21
  assert go() == 3
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

The parameter's type by a name for a function type: a `type`, declared before or after, or an applied generic type.

```ents
func pick(a: i32, b: i32, comptime before: Cmp) -> i32 => if before(a, b) { a } else { b }
func twice(comptime T: type, comptime f: Fn(T), x: T) -> T => f(f(x))
type Cmp = (i32, i32) -> bool
func Fn(comptime T: type) -> type => (T) -> T

func lt(a: i32, b: i32) -> bool => a < b
func inc(x: u32) -> u32 => x + 1

test "a named function type" {
  assert pick(3, 9, lt) == 3
  assert twice(inc, 5) == 7
}
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

## Method calls

`x.f(a)` is the call `f(x, a)` where `x` has no member `f`. Nothing in the syntax is new: it parses as a call of a member, and the checker decides what it is.

```ents Expr
v.push(u32, 7)
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "MemberExpr",
    "object": {
      "kind": "IdentExpr",
      "name": "v"
    },
    "member": {
      "kind": "field",
      "name": "push"
    }
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
        "kind": "LiteralExpr",
        "value": {
          "kind": "int",
          "value": "7",
          "radix": 10
        }
      }
    }
  ]
}
```

A member whose name only starts like a primitive type is a field or a method. A member's name is a whole identifier, hyphens included, so `p.u32-1` is a member called `u32-1`; only a name that is a primitive type's and nothing more is a type pun. A subtraction is written with spaces, as the formatter prints it.

```ents Expr
v.u32s()
```

```json ast
{
  "kind": "CallExpr",
  "callee": {
    "kind": "MemberExpr",
    "object": {
      "kind": "IdentExpr",
      "name": "v"
    },
    "member": {
      "kind": "field",
      "name": "u32s"
    }
  },
  "args": []
}
```

```ents Expr
p.u32-1
```

```json ast
{
  "kind": "MemberExpr",
  "object": {
    "kind": "IdentExpr",
    "name": "p"
  },
  "member": {
    "kind": "field",
    "name": "u32-1"
  }
}
```

```ents Expr
p.u32 - 1
```

```json ast
{
  "kind": "BinaryExpr",
  "op": "-",
  "left": {
    "kind": "MemberExpr",
    "object": {
      "kind": "IdentExpr",
      "name": "p"
    },
    "member": {
      "kind": "type",
      "type": {
        "kind": "PrimitiveType",
        "name": "u32"
      }
    }
  },
  "right": {
    "kind": "LiteralExpr",
    "value": {
      "kind": "int",
      "value": "1",
      "radix": 10
    }
  }
}
```

### Accepted

The receiver is the first argument that is not a comptime one. It decides the type parameters, type arguments are written after it, and calls chain from left to right.

```ents
func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func push(comptime T: type, v: *mut Vec(T), x: T) {
  v.ptr[v.len] = x
  v.len += 1
}
func get(comptime T: type, v: *Vec(T), i: u32) -> T => v.ptr[i]
func items(comptime T: type, v: *Vec(T)) -> []T => v.ptr[0..v.len]
func total(comptime T: type, xs: []T) -> (sum: T) {
  sum = 0
  for x in xs {
    sum += x
  }
}
func double(n: u64) -> u64 => n * 2

data room = mut [0:u64; 8]
data header = mut [0:u8; 12]

test "a vector through method calls" {
  let v = header as *mut Vec(u64)
  v.* = Vec(u64)(room as [*]mut u64, 0, 8)
  v.push(40)
  v.push(u64, 2)
  assert v.get(1) == 2
  assert v.get(u64, 0) == 40
  assert v.items().total() == 42
  assert v.items().total().double().double() == 168
}
```

The same module written with plain calls.

```ents
func hash(k: u32) -> u32 => k * 31
func mix(a: u32, b: u32) -> u32 => (a ^ b) * 17
func pick(comptime T: type, a: T, b: T, first: bool) -> T => if first { a } else { b }

export func f(a: u32, b: u32) -> u32 => a.hash().mix(b.hash()).pick(b, a > b).max(7)
```

```ents same-wasm
func hash(k: u32) -> u32 => k * 31
func mix(a: u32, b: u32) -> u32 => (a ^ b) * 17
func pick(comptime T: type, a: T, b: T, first: bool) -> T => if first { a } else { b }

export func f(a: u32, b: u32) -> u32 => max(pick(mix(hash(a), hash(b)), b, a > b), 7)
```

A comptime function parameter is written in either form, before the receiver's parameter or after it.

```ents
func first(comptime T: type, comptime before: (T, T) -> bool, xs: []T) -> T => if before(xs.ptr[0], xs.ptr[1]) { xs.ptr[0] } else { xs.ptr[1] }
func best(comptime T: type, xs: []T, comptime before: (T, T) -> bool) -> T => if xs.ptr[0].before(xs.ptr[1]) { xs.ptr[0] } else { xs.ptr[1] }
func less(a: u8, b: u8) -> bool => a < b

data pair = [9:u8, 4]

test "a function given after the receiver" {
  assert pair.first(less) == 4
  assert pair.first(u8, less) == 4
  assert pair.best(less) == 4
  assert pair.best(u8, less) == 4
}
```

Members win over functions: a field, also through a pointer, and what a slice, an array and a pointer have built in.

```ents
type Box = (size: u32, n: u32)

func size(b: Box) -> u32 => 99
func n(b: *Box) -> u32 => 98
func len(xs: []u8) -> u32 => 97
func wid(xs: []u8) -> u32 => 96

func through(b: *Box) -> u32 => b.n + n(b)                  // the field, then the function
func of(xs: []u8) -> u32 => xs.len + len(xs) + xs.wid + wid(xs)   // a slice has .len and .wid

data four = [1:u8, 2, 3, 4]
data space = mut [0:u8; 8]

test "the member is the member" {
  let b = Box(5, 6)
  assert b.size == 5
  assert size(b) == 99
  let p = space as *mut Box
  p.* = b
  assert through(p) == 6 + 98
  assert four.len == 4
  assert four.wid == 1
  assert of("abc") == 3 + 97 + 1 + 96
}
```

The receiver gets the conversions any argument gets: a narrower number is widened, `*mut` is passed for `*`, and an array pointer for a slice.

```ents
func wide(n: u64) -> u64 => n + 1
func count(xs: []u8) -> u32 => xs.len
func first(p: *u32) -> u32 => p.*

data four = [1:u8, 2, 3, 4]
data cell = mut [7:u32]

test "a receiver is converted like an argument" {
  let small: u8 = 255
  assert small.wide() == 256
  assert four.count() == 4
  assert "ab".count() == 2
  let p = &cell[0]
  assert p.first() == 7
}
```

A builtin is called the same way, unless the program declares the name.

```ents
func abs(x: i32) -> i32 => 1

export func a(x: f64) -> f64 => x.sqrt().max(1.5).floor()
export func b(x: i64, y: u8) -> u8 => x.clz().max(y)
export func c(x: i32) -> i32 => x.abs()

test "builtins with a receiver" {
  assert a(16.0) == 4.0
  assert a(1.0) == 1.0
  assert b(1, 3) == 63
  assert c(-5) == 1
}
```

### Rejected

A value is not passed for a pointer: no address is taken of the receiver. The message is the same for a generic, with its type arguments left out or written, and for a plain function.

```ents
type Pt = (q: i32, r: i32)

func Vec(comptime T: type) -> type => (ptr: [*]mut T, len: u32, cap: u32)
func push(comptime T: type, v: *mut Vec(T), x: T) { }
func norm(p: *Pt) -> i32 => p.q + p.r

func f(v: Vec(u32)) { v.push(7) }
func g(v: Vec(u32)) { v.push(u32, 7) }
func h(p: Pt) -> i32 => p.norm()
```

```errors
push takes *mut Vec(u32) first; the receiver is a Vec(u32), which is held in registers and has no address
push takes *mut Vec(u32) first; the receiver is a Vec(u32), which is held in registers and has no address
norm takes *Pt first; the receiver is a Pt, which is held in registers and has no address
```

An array written out is no such value: passed for a pointer it is laid out in memory, as it is when it is written as the first argument. A table written out is laid out when the program is compiled, so a row known only at run time is what is wrong with it, said as it is of the argument.

```ents
func tsum(m: *[2][3]i32) -> i32 => m[1][2]

func f(x: i32) -> i32 => [[x, 2, 3], [4, 5, 6]].tsum()
func g(x: i32) -> i32 => [[1, 2, 3], [x; 3]].tsum()
```

```errors
a row of *[2][3]i32 is laid out at compile time: its values must be constants
a row of *[2][3]i32 is laid out at compile time: its values must be constants
```

Nor is a pointer followed for a value: the receiver is an argument like any other.

```ents
type Pt = (q: i32, r: i32)
func norm(p: Pt) -> i32 => p.q + p.r

func f(p: *Pt) -> i32 => p.norm()
func g(p: *Pt) -> i32 => p.*.norm()
```

```errors
receiver: cannot assign *Pt to Pt
```

Neither a member nor a function of the name is one error. A variable of the name is no function.

```ents
type Pt = (q: i32, r: i32)
func double(n: u32) -> u32 => n * 2

func f(p: Pt, x: u32) -> u32 => p.area(x, 2)
func g(x: u32) -> u32 => x.dubble().double()
func h(x: u32, twice: u32) -> u32 => x.twice()
```

```errors
no field 'area' on type Pt, and no function 'area' accepts (Pt, u32, int(2))
no field 'dubble' on type u32, and no function 'dubble' accepts (u32)
no field 'twice' on type u32, and no function 'twice' accepts (u32)
```

A field that is called is still the field. Where a function of its name is there, the error says how that one is called.

```ents
type Box = (size: u32, n: u32)
func size(b: Box) -> u32 => 99

func f(b: Box) -> u32 => b.size()
func g(b: Box) -> u32 => b.n()
```

```errors
cannot call non-function type: u32 ('size' is a field here, and a field wins over the function 'size': write size(...))
cannot call non-function type: u32
cannot assign i32 to u32
```

A receiver with an error of its own is that error alone, however long the chain.

```ents
func double(n: u32) -> u32 => n * 2

func f() -> u32 => nope.double().double().double()
```

```errors
unknown identifier 'nope'
```

The other errors of `x.f(a)` are those of `f(x, a)`, said of the call as it was written: `x` is the receiver, and the arguments are counted after it.

```ents
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }
func zero(comptime T: type) -> T => 0
func double(n: u32) -> u32 => n * 2
func nothing() -> u32 => 0

func a(x: u32) -> u32 => x.double(1)
func b(x: f64) -> u32 => x.double()
func c(x: u32) -> u32 => x.max()
func d(x: u32) -> u32 => x.max(u8, 3)
func e(x: u32) -> u32 => x.zero()
func f(x: u32) -> u32 => x.nothing()
func g(x: u32) -> u32 => x.max(u32, 1.5)
```

```errors
'double' expected 0 arguments after the receiver, got 1
receiver: cannot assign f64 to u32
'max' expects 1 argument after the receiver, or 2 with its type argument written; got 0
receiver: cannot assign u32 to u8
receiver of 'zero' must be a type: T is a type parameter
'nothing' expected 0 arguments, got 1: the receiver is one
argument 2: cannot assign float(1.5) to u32
```

What a message suggests writing is in the form the call has.

```ents
func make(comptime T: type, n: u32) -> T => n as T
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

func a(x: u32) -> u64 => x.make()
func b() -> u32 => (3).max(6)
```

```errors
cannot infer T for 'make': write the type argument, as in x.make(u32)
cannot infer T for 'max' from untyped literals: write .max(i32, ...) or give a literal its type (3:i32)
```

## Calls in a generic body

A call in a generic's body is resolved in each instance, by its name and the types of its arguments. Each type brings its own function, and every call is a direct one.

```ents
type Pt = (q: i32, r: i32)

func eq(a: Pt, b: Pt) -> bool => a.q == b.q && a.r == b.r
func eq(a: u32, b: u32) -> bool => a == b
func index_of(comptime T: type, xs: []T, x: T) -> u32 {
  for i, e in xs {
    return i when e.eq(x)
  }
  return xs.len
}

data nums = [3:u32, 5, 8]
data pts: []Pt = [(1, 2), (3, 4)]

test "each element type has its own eq" {
  assert nums.index_of(8) == 2
  assert index_of(pts, Pt(3, 4)) == 1
  assert pts.index_of(Pt(9, 9)) == 2
}
```

An argument is converted as for any call of the function: in the instance for `u8` the key is widened, in the one for `u64` it is not.

```ents
func wide(n: u64) -> u64 => n + 1
func step(comptime T: type, x: T) -> u64 => wide(x) + x.wide()

test "widened where it has to be" {
  assert step(4:u8) == 10
  assert step(4:u64) == 10
}
```

### Rejected

A type that no function of the name takes is one error in the instance, with one function of the name or with several. It is said once for the instance, however many calls ask.

```ents
type Pt = (q: i32, r: i32)

func eq(a: Pt, b: Pt) -> bool => a.q == b.q && a.r == b.r
func hash(k: u32) -> u32 => k
func hash(k: []u8) -> u32 => k.len
func index_of(comptime T: type, xs: []T, x: T) -> u32 {
  for i, e in xs {
    return i when eq(e, x)
  }
  return xs.len
}
func same(comptime K: type, a: K, b: K) -> bool => hash(a) == hash(b) && a.hash() == b.hash()

export func f(xs: []u32) -> u32 => index_of(xs, 3)
export func g(a: f64, b: f64) -> bool => same(a, b)
```

```errors
no function 'eq' accepts (u32, u32), in index_of(T = u32)
no function 'hash' accepts (f64), in same(K = f64)
```

So is a function that is not declared at all. With a receiver the error also says that the type has no such member.

```ents
func index_of(comptime T: type, xs: []T, x: T) -> u32 {
  for i, e in xs {
    return i when eq(e, x)
  }
  return xs.len
}
func bucket(comptime K: type, k: K, n: u32) -> u32 => k.hash() % n

export func f(xs: []u32) -> u32 => index_of(xs, 3)
export func g(x: f64) -> u32 => bucket(x, 4)
```

```errors
no function 'eq' accepts (u32, u32), in index_of(T = u32)
no field 'hash' on type f64, and no function 'hash' accepts (f64), in bucket(K = f64)
```

A call with the wrong number of arguments for the one function of its name is no requirement on the type. It reads as in any function.

```ents
func eq(a: u32, b: u32) -> bool => a == b
func has(comptime T: type, xs: []T, x: T) -> bool => eq(xs.ptr[0])

export func f(xs: []u32) -> bool => has(xs, 3)
```

```errors
'eq' expected 2 arguments, got 1, in has(T = u32)
```

A function value is not called, in an instance as anywhere: a generic takes the function it calls as a comptime parameter.

```ents
func apply(comptime T: type, f: (T) -> T, x: T) -> T => f(x)
func inc(a: u32) -> u32 => a + 1

export func g(x: u32) -> u32 => apply(inc, x)
```

```errors
calling a function value is not supported yet: only a function named directly, or a comptime function parameter (comptime f: (u32) -> u32), can be called, in apply(T = u32)
```

A name that several functions share is not given for a comptime function parameter: there are no arguments to say which is meant.

```ents
func pick(comptime T: type, a: T, b: T, comptime before: (T, T) -> bool) -> T => if before(a, b) { a } else { b }
func less(a: i32, b: i32) -> bool => a < b
func less(a: f64, b: f64) -> bool => a < b

export func f(a: i32, b: i32) -> i32 => pick(a, b, less)
```

```errors
argument 3 of 'pick' must be the name of a function: before is a comptime function parameter ('less' has several overloads)
```

A generic function does not share its name, with a generic or with any other function.

```ents
func hash(comptime T: type, k: T) -> u32 => sizeof(T)
func hash(k: u32) -> u32 => k
```

```errors
'hash' is already declared: a generic function's name is unique in its module
```

## Value parameters

A comptime parameter of an integer type, `comptime n: u32`, is given a number. Each number makes an instance, which is the generic with the number put where the name is read, and compiles to the function written by hand for that number (reference 8.7).

### Accepted

The number written, inferred from a length, or written as a constant expression: three calls, two instances.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
  for i in n {
    total += xs[i]
  }
}

data primes = [2:u32, 3, 5, 7]
data squares = [1:u32, 4, 9, 16, 25, 36, 49, 64]

export func a() -> u32 => sum(primes)
export func b() -> u32 => sum(8, squares)
export func c() -> u32 => sum(2 + 2, primes)
```

```ents same-wasm
func sum_4(xs: *[4]u32) -> (total: u32) {
  for i in 4 {
    total += xs[i]
  }
}
func sum_8(xs: *[8]u32) -> (total: u32) {
  for i in 8 {
    total += xs[i]
  }
}

data primes = [2:u32, 3, 5, 7]
data squares = [1:u32, 4, 9, 16, 25, 36, 49, 64]

export func a() -> u32 => sum_4(primes)
export func b() -> u32 => sum_8(squares)
export func c() -> u32 => sum_4(primes)
```

A value parameter with a type parameter and a comptime function parameter, called as a method and written out: one instance, `sort<8|i32|ascending>`.

```ents
func sort(comptime n: u32, comptime T: type, xs: *mut [n]T, comptime before: (T, T) -> bool) {
  for i in n {
    for j in n {
      if before(xs[i], xs[j]) {
        let t = xs[i]
        xs[i] = xs[j]
        xs[j] = t
      }
    }
  }
}
func ascending(a: i32, b: i32) -> bool => a < b

data nums = mut [5:i32, 3, 8, 1, 9, 2, 7, 4]

export func up() { nums.sort(ascending) }
export func up2() { sort(8, i32, nums, ascending) }

test "sorted" {
  up()
  assert nums[0] == 1
  assert nums[7] == 9
}
```

```ents same-wasm
func sort_8(xs: *mut [8]i32) {
  for i in 8 {
    for j in 8 {
      if ascending(xs[i], xs[j]) {
        let t = xs[i]
        xs[i] = xs[j]
        xs[j] = t
      }
    }
  }
}
func ascending(a: i32, b: i32) -> bool => a < b

data nums = mut [5:i32, 3, 8, 1, 9, 2, 7, 4]

export func up() { sort_8(nums) }
export func up2() { sort_8(nums) }

test "sorted" {
  up()
  assert nums[0] == 1
  assert nums[7] == 9
}
```

Value parameters of `u8`, `i32` and `u64`. The number is held as its type holds it: `~0` for a `u8` is 255. Instances are in the order of their names as text, so `shift<-3>` comes before `shift<3>`.

```ents
func shift(comptime k: i32, x: i32) -> i32 => x + k
func mask(comptime m: u8, x: u8) -> u8 => x & m
func big(comptime n: u64, x: u64) -> u64 => x + n

export func s(x: i32) -> i32 => shift(0 - 3, x) + shift(3, x)
export func m(x: u8) -> u8 => mask(~0, x) & mask(15, x)
export func b(x: u64) -> u64 => big(5000000000, x)

test "numbers of three types" {
  assert s(10) == 20
  assert m(255) == 15
}
```

```ents same-wasm
func shift_m3(x: i32) -> i32 => x + -3
func shift_3(x: i32) -> i32 => x + 3
func mask_15(x: u8) -> u8 => x & 15
func mask_255(x: u8) -> u8 => x & 255
func big_5000000000(x: u64) -> u64 => x + 5000000000

export func s(x: i32) -> i32 => shift_m3(x) + shift_3(x)
export func m(x: u8) -> u8 => mask_255(x) & mask_15(x)
export func b(x: u64) -> u64 => big_5000000000(x)

test "numbers of three types" {
  assert s(10) == 20
  assert m(255) == 15
}
```

A value passed on in arithmetic, to a length of another generic.

```ents
func fill(comptime n: u32, xs: *mut [n]u8, v: u8) {
  for i in n {
    xs[i] = v
  }
}
func doubled(comptime n: u32, xs: *mut [n * 2]u8) { fill(n * 2, xs, 7) }

data bytes = mut [0:u8; 8]

export func h() { doubled(4, bytes) }
```

```ents same-wasm
func fill_8(xs: *mut [8]u8, v: u8) {
  for i in 8 {
    xs[i] = v
  }
}
func doubled_4(xs: *mut [8]u8) { fill_8(xs, 7) }

data bytes = mut [0:u8; 8]

export func h() { doubled_4(bytes) }
```

A constant expression as the index of a value array: `v[n - 1]` is the third value.

```ents
func last(comptime n: u32, comptime T: type, v: [n]T) -> T => v[n - 1]

export func a(x: f64) -> f64 {
  let v: [3]f64 = [x, 2.0, x * 3.0]
  return last(v)
}
```

```ents same-wasm
func last_3(v: [3]f64) -> f64 => v[2]

export func a(x: f64) -> f64 {
  let v: [3]f64 = [x, 2.0, x * 3.0]
  return last_3(v)
}
```

A generic type with value parameters. `Ring(8, u32)` is the struct its body is; a method call finds `n` and `T` through the field `items: *mut [n]T`.

```ents
func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, count: u32, items: *mut [n]T)

func push(comptime n: u32, comptime T: type, r: *mut Ring(n, T), x: T) {
  r.items[(r.head + r.count) % n] = x
  if r.count < n {
    r.count += 1
  } else {
    r.head = (r.head + 1) % n
  }
}

data cells = mut [0:u32; 8]
data log: Ring(8, u32) = mut (0, 0, cells)

export func record(x: u32) { log.push(x) }
export func record2(x: u32) { log.push(8, u32, x) }
export func size() -> u32 => sizeof(Ring(4 + 4, u32))
export func built(p: *mut [8]u32) -> u32 => Ring(8, u32)(0, 0, p).count
```

```ents same-wasm
type Ring8 = (head: u32#8, count: u32, items: *mut [8]u32)

func push_8(r: *mut Ring8, x: u32) {
  r.items[(r.head + r.count) % 8] = x
  if r.count < 8 {
    r.count += 1
  } else {
    r.head = (r.head + 1) % 8
  }
}

data cells = mut [0:u32; 8]
data log: Ring8 = mut (0, 0, cells)

export func record(x: u32) { push_8(log, x) }
export func record2(x: u32) { push_8(log, x) }
export func size() -> u32 => sizeof(Ring8)
export func built(p: *mut [8]u32) -> u32 => Ring8(0, 0, p).count
```

A generic type with value parameters only, and a value it does not use: `Tagged(4)` and `Tagged(5)` are one type, as a generic type is its body.

```ents
func Words(comptime w: u32) -> type => (bits: *mut [w]u32, count: u32#(w * 32 + 1))
func Tagged(comptime n: u32) -> type => (id: u32)

func words(comptime w: u32, b: *Words(w)) -> u32 => w
func same(t: Tagged(4)) -> Tagged(5) => t

data ws = mut [0:u32; 3]
data seen: Words(3) = mut (ws, 0)

export func w() -> u32 => seen.words()
```

A constructor with value arguments of a type that is not generic stays a value: `Cell(1, 2)` is a `Cell`, which decides `T`.

```ents
type Cell = (x: i32, y: i32)
func keep(comptime T: type, x: T) -> T => x

export func f() -> i32 => keep(Cell(1, 2)).x
```

A buffer per number, laid out once: every call with the same `n` gets the same one.

```ents
func scratch(comptime n: u32) -> *mut [n]u8 => mut [0:u8; n]

export func a() -> *mut [16]u8 => scratch(16)
export func b() -> *mut [64]u8 => scratch(64)
export func c() -> *mut [16]u8 => scratch(16)
```

A `def` sizes a type, also one declared after it, and a length is any constant: `[0x10]u8` is sixteen bytes.

```ents
def size = 64

export func f(p: *mut [size]u8, i: u32#size) -> u8 => p[i]
export func g(p: *[k * 2]u8) -> u32 => p.len
export func h(p: *[0x10]u8) -> u32 => p.len
export func j(p: *[sizeof(u64) * 4]u8, i: u32#(k + 1)) -> u8 => p[i]

def k = 4
```

A typed constant is what it is in any expression, in a length too: `~0:u8` is 255. And behind a pointer an array of fixed arrays is a table, `n` row pointers, so its size is theirs: `*[65536][65537]u8` is as `*[65536]*[65537]u8` is, though `[65536][65537]u8` held by value is too large.

```ents
def m = ~0:u8

export func f(p: *[m]u8, i: u32#(~0:u8)) -> u32 => p.len + i
export func g(t: *[65536][65537]u8, i: u32#65536) -> u32 => t[i].len
```

```ents same-wasm
export func f(p: *[255]u8, i: u32#255) -> u32 => p.len + i
export func g(t: *[65536][65537]u8, i: u32#65536) -> u32 => t[i].len
```

`-n` is the negative number, as `-k` is where `def k = 3` puts 3 for `k`.

```ents
func f(comptime k: i32, x: i32) -> i32 => x * -k

export func a(x: i32) -> i32 => f(3, x)
```

```ents same-wasm
func f_3(x: i32) -> i32 => x * -3

export func a(x: i32) -> i32 => f_3(x)
```

`n = 0` is a number like any other: a loop over the elements needs no proof.

```ents
func total(comptime n: u32, xs: *[n]u32) -> (t: u32) {
  for x in xs {
    t += x
  }
}

data none: *[0]u32 = []

export func z() -> u32 => total(none)
```

A generic nobody calls is only parsed: what its body does with `n` is not checked.

```ents
func f(comptime n: u32) -> u32 {
  n = 3
  return n
}
```

### Rejected at the declaration

Each of these is one mistake and one error.

An upper-case name: a value parameter is named as a value is.

```ents
func f(comptime N: u32, p: *[N]u8) -> u32 => 0
```

```errors
a value parameter's name starts with a lower-case letter: write 'comptime n: u32'
```

A type parameter as the type of a value parameter, and a slice.

```ents
func f(comptime T: type, comptime n: T) -> u32 => 0
func g(comptime s: []u8) -> u32 => 0
```

```errors
comptime parameter 'n' is T: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)
comptime parameter 's' is []u8: a comptime parameter is a type (comptime T: type), an integer (comptime n: u32) or a function (comptime f: (T) -> T)
```

The name of a `def` of the module, which the parser would put in for the name.

```ents
def n = 4
func f(comptime n: u32) -> u32 => 0
```

```errors
comptime parameter 'n' has the name of a def declared in this module
```

The name of another parameter, or of a result.

```ents
func f(comptime n: u32, n: u32) -> u32 => 0
func g(comptime n: u32, x: u32) -> (n: u32) { }
```

```errors
parameter 'n' is declared twice
result 'n' has the name of the comptime value parameter 'n'
```

A run-time parameter as a length.

```ents
func f(len: u32, p: *[len]u8) -> u32 => 0
```

```errors
array length must be a compile-time constant: 'len' is a parameter; to give it at compile time, write comptime len: u32
```

A length that names nothing.

```ents
func f(comptime n: u32, p: *[m]u8) -> u32 => 0
```

```errors
unknown identifier 'm'
```

A generic type with a parameter that is neither a type nor an integer.

```ents
func Box(comptime x: f64) -> type => (a: u32)
```

```errors
generic type 'Box' takes comptime type and integer parameters only, as (comptime n: u32, comptime T: type)
```

A packed array's dimensions are numbers.

```ents
func f(comptime n: u32, comptime m: u32, p: *[n x m]u8) -> u32 => 0
```

```errors
Expected
```

### Rejected at the call

A value that is not known at compile time, for a value parameter.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0

func f(xs: []u32) -> u32 => sum(xs)
func g(x: u32, p: *[4]u32) -> u32 => sum(x, p)
```

```errors
cannot infer n for 'sum': a []u32 has no length in its type; write the value argument, as in sum(8, ...)
argument 1 of 'sum' must be a compile-time constant: n is a comptime value parameter
```

A `data` block and a type, where a number is wanted, and a number where a type is.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0
func get(comptime n: u32, comptime T: type, xs: *[n]T, i: u32#n) -> T => xs[i]

data d = [1:u8]

func f(p: *[4]u32) -> u32 => sum(d, p)
func g(p: *[4]u32) -> u32 => sum(u32, p)
func h(p: *[8]u8) -> u8 => get(8, 8, p, 0)
```

```errors
argument 1 of 'sum' must be a compile-time constant: n is a comptime value parameter
argument 1 of 'sum' must be a compile-time constant: n is a comptime value parameter
argument 2 of 'get' must be a type: T is a type parameter
```

A number the parameter's type does not hold: the errors of any argument.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0
func small(comptime n: u8, xs: *[n]u32) -> u32 => 0

func a(p: *[4]u32) -> u32 => small(300, p)
func b(p: *[4]u32) -> u32 => sum(0 - 1, p)
func c(p: *[4]u32) -> u32 => sum(1.5, p)
func d(p: *[4]u32) -> u32 => sum(4294967296, p)
func e(p: *[4]u32) -> u32 => sum(true, p)
```

```errors
argument 1: cannot assign int(300) to u8
argument 1: cannot assign int(-1) to u32
argument 1: cannot assign float(1.5) to u32
argument 1: cannot assign int(4294967296) to u32
argument 1: cannot assign bool to u32
```

So for a generic type's value parameter: a typed constant by its type, an untyped one by its value.

```ents
func Small(comptime n: u8) -> type => (items: *[n]u8)

func a(s: Small(4:u32)) -> u32 => 0
func b(s: Small(sizeof(u64))) -> u32 => 0
func c(s: Small(300)) -> u32 => 0
```

```errors
argument 1 of 'Small': cannot assign u32 to u8
argument 1 of 'Small': cannot assign u32 to u8
argument 1 of 'Small': cannot assign int(300) to u8
```

Another count of arguments, and named arguments.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0
func push(comptime n: u32, comptime T: type, v: *mut [n]T, x: T) { }

func f(p: *[4]u32) -> u32 => sum(4, 4, p)
func g(p: *mut [4]u32) { push(p, 1, 2) }
func h(p: *[4]u32) -> u32 => sum(n: 4, xs: p)
```

```errors
'sum' expects 1 argument, or 2 with its value argument written; got 3
'push' expects 2 arguments, or 4 with its comptime arguments written; got 3
'sum' takes positional arguments
```

Nothing that decides `n`: no length, a length in arithmetic, a generic type with no length that is `n` alone, an array literal, a value array where a pointer is wanted.

```ents
func pow(comptime e: u32, x: u64) -> u64 => x
func fill(comptime n: u32, comptime T: type, x: T) -> u32 => 0
func set_bit(comptime n: u32, b: *mut [(n + 31) / 32]u32, i: u32#n) { }
func Tagged(comptime n: u32) -> type => (id: u32#n)
func tag(comptime n: u32, t: Tagged(n)) -> u32 => 0
func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0

data seen = mut [0:u32; 4]

func a(x: u64) -> u64 => pow(x)
func b(x: u32) -> u32 => fill(x)
func c(k: u32) { set_bit(seen, k % 100) }
func d(t: Tagged(4)) -> u32 => tag(t)
func e() -> u32 => sum([1, 2, 3])
func f(v: [4]u32) -> u32 => sum(v)
```

```errors
cannot infer e for 'pow': write the value argument, as in pow(8, ...)
cannot infer n for 'fill': write the comptime arguments, as in fill(8, u32, ...)
cannot infer n for 'set_bit': [(n + 31) / 32] does not decide n, only a length that is n alone does; write the value argument, as in set_bit(8, ...)
cannot infer n for 'tag': 'Tagged(n)' has no length that is n alone; write the value argument
cannot infer n for 'sum' from an array literal: write sum(3, ...)
cannot infer n for 'sum': write the value argument, as in sum(8, ...)
```

Once `n` is decided, every other argument is an ordinary argument.

```ents
func join(comptime a: u32, comptime b: u32, x: *[a]u8, y: *[b]u8, out: *mut [a + b]u8) { }
func get(comptime n: u32, comptime T: type, xs: *[n]T, i: u32#n) -> T => xs[i]
func pair(comptime n: u32, a: [n]f64, b: [n]f64) -> f64 => 0.0
func sum(comptime n: u32, xs: *[n]u32) -> u32 => 0

data big = mut [0:u8; 8]
data widths = [3:u16, 1, 4, 1, 5, 9, 2, 6]

func a() { join("hel", "lo", big) }
func b(k: u32) -> u16 => get(widths, k)
func c(k: u32) -> u16 => get(widths, k & 15)
func d(x: [3]f64, y: [4]f64) -> f64 => pair(x, y)
func e(v: [4]u32) -> u32 => sum(4, v)
```

```errors
argument 3: cannot assign *mut [8]u8 to *mut [5]u8
argument 2: cannot assign u32 to u32#8
argument 2: cannot assign u32#16 to u32#8
argument 2: cannot assign [4]f64 to [3]f64
argument 2: cannot assign [4]u32 to *[4]u32
```

A number for a generic type's value parameter.

```ents
func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, items: *mut [n]T)
func Small(comptime n: u8) -> type => (items: *[n]u8)

func a(r: Ring(u32, u8)) -> u32 => 0
func b(r: Small(300)) -> u32 => 0
func c(x: u32, r: *Ring(x, u8)) -> u32 => 0
```

```errors
argument 1 of 'Ring' must be a compile-time constant: n is a comptime value parameter
argument 1 of 'Small': cannot assign int(300) to u8
argument 1 of 'Ring' must be a compile-time constant: n is a comptime value parameter
```

### Rejected in an instance

Each error is reported at its line in the generic, once for each instance, and labelled with it.

A bound of 0, and a bound past its type.

```ents
func get(comptime n: u32, comptime T: type, xs: *[n]T, i: u32#n) -> T => xs[i]
func narrow(comptime n: u32, x: u8#n) -> u8 => x

export func f() -> u8 => get("", 0)
export func g() -> u8 => narrow(300, 1)
```

```errors
range bound must be at least 1: u32#0 has no values, in get(n = 0, T = u8)
range bound 300 is too large for u8, which has 256 values, in narrow(n = 300)
```

A negative length, a length past a `u32`, and an array too large for memory.

```ents
func neg(comptime k: i32, p: *[k]u8) -> u32 => 0
func long(comptime n: u64, p: *[n]u8) -> u32 => 0
func wide(comptime n: u32, p: *[n]u64) -> u32 => 0

export func a(p: *[1]u8) -> u32 => neg(0 - 1, p)
export func b(p: *[1]u8) -> u32 => long(4294967296, p)
export func c(p: *[1]u64) -> u32 => wide(536870912, p)
```

```errors
array length cannot be negative: it is -1, in neg(k = -1)
array length 4294967296 is too large: an array has at most 4294967295 elements, in long(n = 4294967296)
array [536870912]u64 is too large: 4294967296 bytes, more than the 4294967295 a 32-bit memory addresses, in wide(n = 536870912)
```

`n` is no variable: it cannot be assigned to, and its name cannot be bound again.

```ents
func f(comptime n: u32, p: ?*u32, x: u32) -> u32 {
  n = 3
  n += 1
  let y = 1
  set (n, y) = (1, 2)
  for n in 4 { }
  if let n = p { return 1 }
  return match x { n => 1 }
}
func h(comptime n: u32) -> u32 {
  let n = 5
  return n
}

export func g(p: ?*u32, x: u32) -> u32 => f(8, p, x) + h(8)
```

```errors
cannot assign to 'n': it is a comptime value parameter, in f(n = 8)
cannot assign to 'n': it is a comptime value parameter, in f(n = 8)
cannot set 'n': it is a comptime value parameter, in f(n = 8)
'n' is already declared: a loop variable cannot reuse the name of a comptime value parameter (first declared at 1:17), in f(n = 8)
'n' is already declared: an if let binding cannot reuse the name of a comptime value parameter (first declared at 1:17), in f(n = 8)
'n' is already declared: a match binding cannot reuse the name of a comptime value parameter (first declared at 1:17), in f(n = 8)
'n' is already declared in this scope (first declared at 10:17), in h(n = 8)
```

`n = 0` where the body needs an index proven: the error of the same function written by hand for 0.

```ents
func sum(comptime n: u32, xs: *[n]u32) -> (total: u32) {
  for i in n {
    total += xs[i]
  }
}

data none: *[0]u32 = []

export func z() -> u32 => sum(none)
```

```errors
runtime index on *[0]u32 requires 'if let' or '??' (no optional type for u32), in sum(n = 0)
```

A value array held in registers is indexed by constants only.

```ents
func total(comptime n: u32, v: [n]u32) -> (s: u32) {
  for i in n {
    s += v[i]
  }
}

export func g(v: [4]u32) -> u32 => total(v)
```

```errors
dynamic index on value type [4]u32 — use a pointer or slice for dynamic access, in total(n = 4)
```

Recursion on a value that changes: with no compile-time `if`, each instance asks for the next, until a value its type refuses or the limit of nested instantiations.

```ents
func pow(comptime e: u32, x: u64) -> u64 => if e == 0 { 1 } else { x * pow(e - 1, x) }
func count(comptime n: u32, x: u32) -> u32 => if x == 0 { n } else { count(n + 1, x - 1) }

export func cube(x: u64) -> u64 => pow(3, x)
export func g(x: u32) -> u32 => count(0, x)
```

```errors
argument 1: cannot assign int(-1) to u32, in pow(e = 0)
too many nested instantiations (64) while instantiating 'count', in count(n = 63)
```

The number put where it does not fit.

```ents
func f(comptime n: u32) -> u8 {
  let b: u8 = n
  return b
}

export func g() -> u8 => f(300)
```

```errors
cannot assign int(300) to u8, in f(n = 300)
```

An error a number makes in the body of a generic type is the application's, reported once for each, with the use it was required from: `Ring(0, u32)` and `Ring(0, u8)` are two. What is made of it says nothing more. A body that applies its type to numbers that grow is stopped at once: by the parameter's type here, or at 1000 levels.

```ents
func Ring(comptime n: u32, comptime T: type) -> type => (head: u32#n, count: u32, items: *mut [n]T)
func T2(comptime n: u32) -> type => (a: *T2(n * 2), b: *T2(n * 2 + 1))

export func f(r: *Ring(0, u32)) -> u32 => r.count
export func g(r: *Ring(0, u8)) -> u32 => r.count
export func h(t: *T2(1)) -> u32 => 0
```

```errors
range bound must be at least 1: u32#0 has no values, in Ring(0, u32)
range bound must be at least 1: u32#0 has no values, in Ring(0, u8)
argument 1 of 'T2': cannot assign int(4294967296) to u32, in T2(2147483648)
```

A length that divides by zero.

```ents
func chunk(comptime n: u32, p: *[64 / n]u8) -> u32 => p.len

export func a(p: *[8]u8) -> u32 => chunk(0, p)
```

```errors
array length divides by zero, in chunk(n = 0)
```

A hyphen joins a name: `n-1` is no subtraction. In a signature that is found where the generic is declared, and in its body in each instance.

```ents
func f(comptime n: u32, p: *[n]u8, q: *[n-1]u8) -> u8 => 0
func last(comptime n: u32, p: *[n]u8) -> u8 => p[n-1] ?? 0

export func g(p: *[4]u8) -> u8 => last(p)
```

```errors
unknown identifier 'n-1': a hyphen joins a name; for subtraction write n - 1
unknown identifier 'n-1': a hyphen joins a name; for subtraction write n - 1, in last(n = 4)
```

### Rejected in any type

A length or a bound is a constant, an integer, and within its limits, also written by hand.

```ents
export func a(q: *[4]u8) -> u32 {
  let x: u32 = 4
  let p: *[x]u8 = q
  return 0
}
export func b(i: u32#(1.5)) -> u32 => 0
export func c(p: *[2.5]u8) -> u32 => 0
export func d(i: u32#0) -> u32 => 0
export func e(i: u8#300) -> u32 => 0
export func f(p: *[4294967296]u8) -> u32 => 0
export func g(p: *[1000000000]u64) -> u32 => 0
export func h() -> u32 => sizeof([536870912]u64)
```

```errors
range bound must be an integer: it is float(1.5)
array length must be an integer: it is float(2.5)
range bound must be at least 1: u32#0 has no values
range bound 300 is too large for u8, which has 256 values
array length 4294967296 is too large: an array has at most 4294967295 elements
array [1000000000]u64 is too large: 8000000000 bytes, more than the 4294967295 a 32-bit memory addresses
array length must be a compile-time constant
array [536870912]u64 is too large: 4294967296 bytes, more than the 4294967295 a 32-bit memory addresses
```

A typed constant that its type does not hold, and a division by zero.

```ents
export func f(p: *[300:u8]u8) -> u32 => p.len
export func g(p: *[7 / 0]u8) -> u32 => p.len
```

```errors
cannot assign int(300) to u8
array length divides by zero
```

A hyphen where a subtraction was meant, with `n` a name in scope.

```ents
export func f(n: u32, v: *[8]u8) -> u8 => v[n-1] ?? 0
```

```errors
unknown identifier 'n-1': a hyphen joins a name; for subtraction write n - 1
```

A repeat literal is an array too.

```ents
data d = mut [0:u64; 536870912]
```

```errors
array [536870912]u64 is too large: 4294967296 bytes, more than the 4294967295 a 32-bit memory addresses
```

## Imported generics

A block here is checked on its own, as the editor checks a file it cannot read the imports of: a generic function imported from a source module is then known by the signature the import writes. Its calls are checked against that signature with the types filled in. What its body requires of them is found out when the program is checked, which the fixtures under `packages/compiler/tests/fixtures/generics` and `loader.test.ts` do. A block with a source import is never compiled.

### Accepted

Explicit and inferred calls, and a method call, of imported generics.

```ents
import "./containers" (
  "max" func max(comptime T: type, a: T, b: T) -> T
  "first" func first(comptime T: type, xs: []T) -> T
)

export func widest(a: u32, b: u32) -> u32 => max(u32, a, b)
export func longest(a: f64) -> f64 => a.max(0.5)
export func head(xs: []u64) -> u64 => first(xs)
```

A generic type imported as the function it is. What it is, and so what anything made of it is, is known only when the program is checked: a module that imports one and is checked on its own lists no errors, and has one warning, `imported generic types are resolved only when the program is checked`. The mistake below (`y` is declared nowhere) is reported when the program is checked.

```ents
import "./containers" (
  "Vec" func Vec(comptime T: type) -> type
  "vec" func vec(comptime T: type, cap: u32) -> *mut Vec(T)
  "push" func push(comptime T: type, v: *mut Vec(T), x: T)
)

export func count(x: u32) -> u32 {
  let v = vec(u32, 4)
  v.push(x)
  v.push(y)
  return v.len
}
```

### Rejected

A call of an imported generic is checked as a call of a generic declared in the module is.

```ents
import "./containers" "max" func max(comptime T: type, a: T, b: T) -> T

func f(a: u8, b: u32) -> u32 => max(a, b)
```

```errors
argument 2: cannot assign u32 to u8
```

```ents
import "./containers" "zero" func zero(comptime T: type) -> T

func f() -> u32 => zero()
```

```errors
cannot infer T for 'zero': write the type argument, as in zero(u32)
```

The import's signature is held to the rules of a generic's declaration.

```ents
import "./containers" "pick" func pick(T: type, a: u32, b: u32) -> u32
```

```errors
a parameter of type 'type' must be comptime: write 'comptime T: type'
```

An imported generic's name is unique in its module.

```ents
import "./containers" "max" func max(comptime T: type, a: T, b: T) -> T

func max(a: u32, b: u32) -> u32 => a
```

```errors
'max' is already declared: a generic function's name is unique in its module
```

A generic type imported from the host.

```ents
import "env" "Vec" func Vec(comptime T: type) -> type
```

```errors
a host import cannot have comptime parameters
```

<!-- spec:end -->
