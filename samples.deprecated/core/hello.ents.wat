(module
  (func $fd-write 
    (import "wasi_snapshot_preview1" "fd_write")
    (param i32 i32 i32 i32) (result i32)
  )
  (func 
    (export "_start")
    (i32.const 1)
    (i32.const 0)
    (i32.const 1)
    (i32.const 20)
    (call $fd-write)
    (drop)
  )
  (memory (export "memory") 1)
  (data (i32.const 0) "\08\00\00\00\0c\00\00\00hello world\0a")
)