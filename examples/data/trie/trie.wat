(module
  (func $walk (export "walk-trie") (param $trie i32 i32) (param $key i64) (result i64)
    (local $trie_offset i32)
    (local $bit_offset i32)
    (i32.const 0)
    (local.set $trie_offset)
    (i32.const 0)
    (local.set $bit_offset)
    ;; TODO: LoopStmt
  )
)