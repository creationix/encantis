(module
  (memory (export "mem") 1)
  (func $gimli (export "gimli") (param $state i32)
    (local $round i32)
    (i32.const 24)
    (local.set $round)
    ;; TODO: LoopStmt
  )
  (func $gimli_hash (export "gimli_hash") (param $input i32 i32) (param $output i32)
    (local $state i32)
    (i32.const 0)
    (local.set $state)
    (local.get $input_len)
    (local.set $len)
    (local.get $input_ptr)
    (local.set $input_ptr)
    ;; TODO: WhileStmt
    ;; TODO: ForStmt
    ;; TODO: GroupExpr
    (local.get $len)
    (i32.add)
    (i32.load)
    (i32.const 0x1f)
    (i32.xor)
    ;; TODO: indexed store
    ;; TODO: GroupExpr
    (i32.const 15)
    (i32.add)
    (i32.load)
    (i32.const 0x80)
    (i32.xor)
    ;; TODO: indexed store
    (call $gimli (local.get $state))
    (drop)
    ;; TODO: ForStmt
    (call $gimli (local.get $state))
    (drop)
    ;; TODO: ForStmt
  )
)