(module
  (memory (export "mem") 1)
  (func $gimli (export "gimli") (param $state i32)
    (local $round i32)
    (local.set $round (i32.const 24))
    ;; TODO: LoopStmt
  )
  (func $gimli_hash (export "gimli_hash") (param $input_ptr i32) (param $input_len i32) (param $output i32)
    (local $state i32)
    (local $len i32)
    (local $input_ptr i32)
    (local.set $state (i32.const 0))
    (local.set $len (local.get $input_len))
    (local.set $input_ptr (local.get $input_ptr))
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
    ;; TODO: ForStmt
    (call $gimli (local.get $state))
    ;; TODO: ForStmt
  )
)