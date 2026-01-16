(module
  (memory (export "mem") 1)
  (func $gimli (export "gimli") (param $state i32)
    (local $round i32)
    (local $col i32)
    (local $x i32)
    (local $y i32)
    (local $z i32)
    (local.set $round (i32.const 24))
    (block $loop_exit_0
      (loop $loop_0
        (local.set $col (i32.const 0))
        (block $for_exit_1
          (loop $for_1
            (br_if $for_exit_1 (i32.ge_s (local.get $col) (i32.const 4)))
            (local.set $x (i32.rotl (i32.load (i32.add (local.get $state) (i32.shl (local.get $col) (i32.const 2)))) (i32.const 24)))
            (local.set $y (i32.rotl (i32.load (i32.add (local.get $state) (i32.shl (i32.add (local.get $col) (i32.const 4)) (i32.const 2)))) (i32.const 9)))
            (local.set $z (i32.load (i32.add (local.get $state) (i32.shl (i32.add (local.get $col) (i32.const 8)) (i32.const 2)))))
            (i32.xor (i32.xor (local.get $x) (i32.shl (local.get $z) (i32.const 1))) (i32.shl (i32.and (local.get $y) (local.get $z)) (i32.const 2)))
            ;; TODO: indexed store
            (i32.xor (i32.xor (local.get $y) (local.get $x)) (i32.shl (i32.or (local.get $x) (local.get $z)) (i32.const 1)))
            ;; TODO: indexed store
            (i32.xor (i32.xor (local.get $z) (local.get $y)) (i32.shl (i32.and (local.get $x) (local.get $y)) (i32.const 3)))
            ;; TODO: indexed store
            (local.set $col (i32.add (local.get $col) (i32.const 1)))
            (br $for_1)
          )
        )
        (i32.const 0)
        (local.set $round (i32.sub (local.get $round) (i32.const 1)))
        (br_if $loop_exit_0 (i32.eq (local.get $round) (i32.const 0)))
        (br $loop_0)
      )
    )
  )
  (func $gimli_hash (export "gimli_hash") (param $input_ptr i32) (param $input_len i32) (param $output i32)
    (local $state i32)
    (local $len i32)
    (local $input_ptr_2 i32)
    (local $i i32)
    (local $i_2 i32)
    (local $i_2 i32)
    (local $i_2 i32)
    (local.set $state (i32.const 0))
    (local.set $len (local.get $input_len))
    (local.set $input_ptr_2 (local.get $input_ptr_2))
    (block $while_exit_2
      (loop $while_2
        (br_if $while_exit_2 (i32.eqz (i32.ge_s (local.get $len) (i32.const 16))))
        (local.set $i_2 (i32.const 0))
        (block $for_exit_3
          (loop $for_3
            (br_if $for_exit_3 (i32.ge_s (local.get $i_2) (i32.const 16)))
            (local.get $state)
            (local.get $i_2)
            (i32.add)
            (i32.load)
            (i32.load (i32.add (local.get $input_ptr_2) (i32.shl (local.get $i_2) (i32.const 2))))
            (i32.xor)
            ;; TODO: indexed store
            (local.set $i_2 (i32.add (local.get $i_2) (i32.const 1)))
            (br $for_3)
          )
        )
        (call $gimli (local.get $state))
        (local.set $input_ptr_2 (i32.add (local.get $input_ptr_2) (i32.const 16)))
        (local.set $len (i32.sub (local.get $len) (i32.const 16)))
        (br $while_2)
      )
    )
    (local.set $i_2 (i32.const 0))
    (block $for_exit_4
      (loop $for_4
        (br_if $for_exit_4 (i32.ge_s (local.get $i_2) (local.get $len)))
        (local.get $state)
        (local.get $i_2)
        (i32.add)
        (i32.load)
        (i32.load (i32.add (local.get $input_ptr_2) (i32.shl (local.get $i_2) (i32.const 2))))
        (i32.xor)
        ;; TODO: indexed store
        (local.set $i_2 (i32.add (local.get $i_2) (i32.const 1)))
        (br $for_4)
      )
    )
    (local.get $state)
    (local.get $len)
    (i32.add)
    (i32.load)
    (i32.const 0x1f)
    (i32.xor)
    ;; TODO: indexed store
    (local.get $state)
    (i32.const 15)
    (i32.add)
    (i32.load)
    (i32.const 0x80)
    (i32.xor)
    ;; TODO: indexed store
    (call $gimli (local.get $state))
    (local.set $i_2 (i32.const 0))
    (block $for_exit_5
      (loop $for_5
        (br_if $for_exit_5 (i32.ge_s (local.get $i_2) (i32.const 16)))
        (i32.load (i32.add (local.get $state) (i32.shl (local.get $i_2) (i32.const 2))))
        ;; TODO: indexed store
        (local.set $i_2 (i32.add (local.get $i_2) (i32.const 1)))
        (br $for_5)
      )
    )
    (call $gimli (local.get $state))
    (local.set $i_2 (i32.const 0))
    (block $for_exit_6
      (loop $for_6
        (br_if $for_exit_6 (i32.ge_s (local.get $i_2) (i32.const 16)))
        (i32.load (i32.add (local.get $state) (i32.shl (local.get $i_2) (i32.const 2))))
        ;; TODO: indexed store
        (local.set $i_2 (i32.add (local.get $i_2) (i32.const 1)))
        (br $for_6)
      )
    )
  )
)