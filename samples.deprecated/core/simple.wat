(module

  ;; Import a system API
  (func $print (import "sys" "print")
    (param i32 i32)
  )

  ;; Define a library function and export it
  (func $distance (export "distance")
    (param f32 f32) (result f32)
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

  ;; Print Hello World in _start
  (func (export "_start")
    (call $print
      (i32.const 0)
      (i32.const 11)
    )
  )

  (memory (export "memory") 1)
  (data (i32.const 0) "Hello world")
)