(module
  (memory (export "mem") 1)

  (global $PRIME32_1 i32 (i32.const 2654435761))
  (global $PRIME32_2 i32 (i32.const 2246822519))
  (global $PRIME32_3 i32 (i32.const 3266489917))
  (global $PRIME32_4 i32 (i32.const 668265263))
  (global $PRIME32_5 i32 (i32.const 374761393))

  (func (export "xxh32") (param $ptr i32) (param $len i32) (param $seed i32) (result i32)
        (local $h32 i32)
        (local $end i32)
        (local $limit i32)
        (local $v1 i32)
        (local $v2 i32)
        (local $v3 i32)
        (local $v4 i32)
        (local.set $end (i32.add (local.get $ptr) (local.get $len)))
        (if
          (i32.ge_u (local.get $len) (i32.const 16))
          (then
            (block
              (local.set $limit (i32.sub (local.get $end) (i32.const 16)))
              (local.set $v1 (i32.add (i32.add (local.get $seed) (global.get $PRIME32_1)) (global.get $PRIME32_2)))
              (local.set $v2 (i32.add (local.get $seed) (global.get $PRIME32_2)))
              (local.set $v3 (i32.add (local.get $seed) (i32.const 0)))
              (local.set $v4 (i32.sub (local.get $seed) (global.get $PRIME32_1)))
              ;; For every chunk of 4 words, so 4 * 32bits = 16 bytes
              (loop $4words-loop
                    (local.set $v1 (call $round32 (local.get $v1) (i32.load (local.get $ptr))))
                    (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
                    (local.set $v2 (call $round32 (local.get $v2) (i32.load (local.get $ptr))))
                    (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
                    (local.set $v3 (call $round32 (local.get $v3) (i32.load (local.get $ptr))))
                    (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
                    (local.set $v4 (call $round32 (local.get $v4) (i32.load (local.get $ptr))))
                    (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
                    (br_if $4words-loop (i32.le_u (local.get $ptr) (local.get $limit))))
              (local.set $h32 (i32.add
                                (i32.rotl (local.get $v1) (i32.const 1))
                                (i32.add
                                  (i32.rotl (local.get $v2) (i32.const 7))
                                  (i32.add
                                    (i32.rotl (local.get $v3) (i32.const 12))
                                    (i32.rotl (local.get $v4) (i32.const 18)))))))
          )
          (else
            ;; else block, when input is smaller than 16 bytes
            (local.set $h32 (i32.add (local.get $seed) (global.get $PRIME32_5)))
          )

        )
        (local.set $h32 (i32.add (local.get $h32) (local.get $len)))
        ;; For the remaining words not covered above, either 0, 1, 2 or 3
        (block $exit-remaining-words
               (loop $remaining-words-loop
                     (br_if $exit-remaining-words (i32.gt_u (i32.add (local.get $ptr) (i32.const 4)) (local.get $end)))
                     (local.set $h32 (i32.add (local.get $h32) (i32.mul (i32.load (local.get $ptr)) (global.get $PRIME32_3))))
                     (local.set $h32 (i32.mul (i32.rotl (local.get $h32) (i32.const 17)) (global.get $PRIME32_4)))
                     (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
                     (br $remaining-words-loop)))
        ;; For the remaining bytes that didn't make a whole word,
        ;; either 0, 1, 2 or 3 bytes, as 4bytes = 32bits = 1 word.
        (block $exit-remaining-bytes
               (loop $remaining-bytes-loop
                     (br_if $exit-remaining-bytes (i32.ge_u (local.get $ptr) (local.get $end)))
                     (local.set $h32 (i32.add (local.get $h32) (i32.mul (i32.load8_u (local.get $ptr)) (global.get $PRIME32_5))))
                     (local.set $h32 (i32.mul (i32.rotl (local.get $h32) (i32.const 11)) (global.get $PRIME32_1)))
                     (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
                     (br $remaining-bytes-loop)))
        ;; Finalise
        (local.set $h32 (i32.xor (local.get $h32) (i32.shr_u (local.get $h32) (i32.const 15))))
        (local.set $h32 (i32.mul (local.get $h32) (global.get $PRIME32_2)))
        (local.set $h32 (i32.xor (local.get $h32) (i32.shr_u (local.get $h32) (i32.const 13))))
        (local.set $h32 (i32.mul (local.get $h32) (global.get $PRIME32_3)))
        (local.set $h32 (i32.xor (local.get $h32) (i32.shr_u (local.get $h32) (i32.const 16))))
        (local.get $h32))

  (func $round32 (param $seed i32) (param $value i32) (result i32)
        (local.set $seed (i32.add  (local.get $seed) (i32.mul (local.get $value) (global.get $PRIME32_2))))
        (local.set $seed (i32.rotl (local.get $seed) (i32.const 13)))
        (local.set $seed (i32.mul (local.get $seed) (global.get $PRIME32_1)))
        (local.get $seed))
)
