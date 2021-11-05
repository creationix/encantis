
;; for..in sugar works on integers
;; it iterates from 0 to n-1
(func $sum (param $n i32) (result u32)
  (local $s i32)
  (local $i i32)
  (local.set $s (i32.const 0)) ;; s = 0
  (local.set $i (i32.const 0)) ;; for i in n do
  (block
    (loop
      (br_if 1 (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $s (i32.add (local.get $s) (local.get $i))) ;; s += i
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br 0)
    )
  )
  (local.get $i)
)

;; for..in also works on slices
;; it iterates on the values and automatically stops
(func $iterate
  ;; local str: <u8>
  (param $str_base i32) (param $str_len i32)

  ;; for char in str do
  (local $1 i32)
  (local.set $1 (i32.add (local.get $str_base) (local.get $str_len)))
  (block
    (loop
      (br_if 1 (i32.ge_u (local.get $str_base) (local.get $1)))

      ;; print(char)
      (call $print (i32.load8_u (local.get $str_base)))

      (local.set $str_base (i32.add (local.get $str_base) (i32.const 1)))
      (br 0)
    )
  )
  ;; end
)


;; for..in also works on zero terminated arrays
;; it iterates on the values and automatically stops
;; func iterate (str: [u8]) -> void
(func $iterate (param $ptr i32)

  ;; for char in str do
  (local $1)
  (block
    (loop
      (local.set $1 (i32.load8_u $str_ptr))
      (br_if 1 (i32.eqz (local.get $1))

      ;; print(char)
      (call $print (local.get $1))

      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br 0)
    )
  )
  ;; end
)
