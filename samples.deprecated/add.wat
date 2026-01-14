(module
  ;; Add two numbers together.
  (func $add (export "add") (param i32 i32) (result i32)
    (i32.add 
      (local.get 0)
      (local.get 1)
    )
  )

  ;; Distance to a point
  (func $distance (export "distance") (param f32 f32) (result f32)
    (f32.sqrt
      (f32.add
        (f32.mul 
          (local.get 0)
          (local.get 0)
        )
        (f32.mul 
          (local.get 1)
          (local.get 1)
        )
      )
    )
  )

  ;; Multiple return values using tuple
  (func $idiv (export "idiv") (param i32 i32) (result i32 i32)
    (i32.div_s
      (local.get 0)
      (local.get 1)
    )
    (i32.rem_s
      (local.get 0)
      (local.get 1)
    )
  )
)
