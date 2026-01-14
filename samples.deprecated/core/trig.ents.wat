(module

  (func $sin (import "math" "sin") (param f32) (result f32))
  (func $cos (import "math" "cos") (param f32) (result f32))
  (func $atan2 (import "math" "atan2") (param f32 f32) (result f32))

  ;; export "to_polar"
  ;; func (x:f32, y:f32) -> (d:f32, a:f32)
  ;;   => (sqrt(x * x + y * y), atan2(y, x))
  (func (export "to_polar") (param $x f32) (param $y f32) (result f32 f32)
    (f32.sqrt
      (f32.add
        (f32.mul
          (local.get $x)
          (local.get $x)
        )
        (f32.mul
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
  ;; func (d:f32, a:f32) -> (x:f32, y:f32)
  ;;   => (cos(a) * d, sin(a) * d)
  (func (export "from_polar") (param $d f32) (param $a f32) (result f32 f32)
    (f32.mul
      (local.get $d)
      (call $cos
        (local.get $a)
      )
    )
    (f32.mul
      (local.get $d)
      (call $sin
        (local.get $a)
      )
    )
  )

)
