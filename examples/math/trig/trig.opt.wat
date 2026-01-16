(module
  (type (;0;) (func (param f64) (result f64)))
  (type (;1;) (func (param f64 f64) (result f64 f64)))
  (type (;2;) (func (param f64 f64) (result f64)))
  (type (;3;) (func (param i32 i32 f64 i32 i32 f64 i32 i32)))
  (type (;4;) (func))
  (func (;0;) (import "math" "sin") (type 0) (param f64) (result f64))
  (func (;1;) (import "math" "cos") (type 0) (param f64) (result f64))
  (func (;2;) (import "math" "atan2") (type 2) (param f64 f64) (result f64))
  (func (;3;) (import "sys" "print-f64-pair") (type 3) (param i32 i32 f64 i32 i32 f64 i32 i32))
  (func (;4;) (export "to_polar") (type 1) (param f64 f64) (result f64 f64)
    (f64.sqrt
      (f64.add
        (f64.mul
          (local.get 0)
          (local.get 0))
        (f64.mul
          (local.get 1)
          (local.get 1))))
    (call 2
      (local.get 1)
      (local.get 0)))
  (func (;5;) (export "from_polar") (type 1) (param f64 f64) (result f64 f64)
    (f64.mul
      (call 1
        (local.get 1))
      (local.get 0))
    (f64.mul
      (call 0
        (local.get 1))
      (local.get 0)))
  (func (;6;) (export "_start") (type 4)
    (local f64 f64 f64 f64 f64)
    (call 4
      (f64.const 0x1.8cccccccccccdp+1 (;=3.1;))
      (f64.const 0x1.0cccccccccccdp+2 (;=4.2;)))
    (local.set 1)
    (local.tee 0)
    (local.set 4
      (local.get 1))
    (drop)
    (local.set 2
      (local.get 4))
    (i32.const 0)
    (i32.const 20)
    (local.get 0)
    (drop
      (local.get 1))
    (local.tee 3)
    (i32.const 21)
    (i32.const 2)
    (local.get 2)
    (i32.const 24)
    (i32.const 1)
    (call 3)
    (i32.const 26)
    (i32.const 24)
    (call 5
      (local.get 3)
      (local.get 2))
    (local.set 1)
    (local.tee 0)
    (drop
      (local.get 1))
    (i32.const 21)
    (i32.const 2)
    (local.get 0)
    (local.set 4
      (local.get 1))
    (drop)
    (local.get 4)
    (i32.const 24)
    (i32.const 1)
    (call 3))
  (memory (;0;) (export "memory") 1)
  (data (;0;) (i32.const 0) "Polar coordinates: (\00, \00)\00Cartesian coordinates: ("))
