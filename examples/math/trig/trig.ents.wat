(module
  ;; Import math functions with f64 precision
  (func $sin (import "math" "sin") (param f64) (result f64))
  (func $cos (import "math" "cos") (param f64) (result f64))
  (func $atan2 (import "math" "atan2") (param f64 f64) (result f64))

  ;; Import sys.print-f64-pair function
  ;; Signature: print([u8], f64, [u8], f64, [u8])
  ;; Takes: str_ptr, str_len, f64_val1, str2_ptr, str2_len, f64_val2, str3_ptr, str3_len
  (func $print (import "sys" "print-f64-pair") 
    (param i32 i32 f64 i32 i32 f64 i32 i32))

  ;; export "to_polar"
  ;; func (x:f64, y:f64) -> (d:f64, a:f64)
  ;;   => sqrt(x * x + y * y), atan2(y, x)
  (func $to_polar (export "to_polar") (param $x f64) (param $y f64) (result f64 f64)
    (f64.sqrt
      (f64.add
        (f64.mul
          (local.get $x)
          (local.get $x)
        )
        (f64.mul
          (local.get $y)
          (local.get $y)
        )
      )
    )
    (call $atan2
      (local.get $y)
      (local.get $x)
    )
  )

  ;; export "from_polar"
  ;; func (d:f64, a:f64) -> (x:f64, y:f64)
  ;;   => cos(a) * d, sin(a) * d
  (func $from_polar (export "from_polar") (param $d f64) (param $a f64) (result f64 f64)
    (f64.mul
      (call $cos
        (local.get $a)
      )
      (local.get $d)
    )
    (f64.mul
      (call $sin
        (local.get $a)
      )
      (local.get $d)
    )
  )

  ;; export "_start"
  ;; func ()
  (func (export "_start")
    (local $x f64)
    (local $y f64)
    (local $d f64)
    (local $a f64)

    ;; Initialize variables
    (local.set $x (f64.const 3.1))
    (local.set $y (f64.const 4.2))

    ;; Convert from cartesian to polar coordinates
    ;; d, a = to_polar(x, y)
    (call $to_polar (local.get $x) (local.get $y))
    (local.set $a) ;; second result
    (local.set $d) ;; first result

    ;; Print the result: print("Polar coordinates: (", d, ", ", a, ")")
    (call $print
      (i32.const 0) (i32.const 20)     ;; "Polar coordinates: ("
      (local.get $d)
      (i32.const 20) (i32.const 2)    ;; ", "
      (local.get $a)
      (i32.const 22) (i32.const 1))   ;; ")"

    ;; Convert from polar to cartesian coordinates
    ;; x, y = from_polar(d, a)
    (call $from_polar (local.get $d) (local.get $a))
    (local.set $y) ;; second result
    (local.set $x) ;; first result

    ;; Print the result: print("Cartesian coordinates: (", x, ", ", y, ")")
    (call $print
      (i32.const 23) (i32.const 24)   ;; "Cartesian coordinates: ("
      (local.get $x)
      (i32.const 20) (i32.const 2)    ;; ", "
      (local.get $y)
      (i32.const 22) (i32.const 1))   ;; ")"
  )

  ;; Memory for string literals
  (memory (export "memory") 1)
  (data (i32.const 0) "Polar coordinates: (, )Cartesian coordinates: (")
)
