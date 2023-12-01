;; challenge 1

;; The newly-improved calibration document consists of lines of text; each line originally contained a specific calibration value that the Elves now need to recover. On each line, the calibration value can be found by combining the first digit and the last digit (in that order) to form a single two-digit number.

;; For example:

;; 1abc2
;; pqr3stu8vwx
;; a1b2c3d4e5f
;; treb7uchet
;; In this example, the calibration values of these four lines are 12, 38, 15, and 77. Adding these together produces 142.

;; Consider your entire calibration document. What is the sum of all of the calibration values?

;; The function that will be called by the host
(func 
  (export "calibration-sum")
  (param $input_ptr i32)
  (param $input_len i32)
  (result i32)
  
  (local $sum i32)
  (local $state i32)
  (local $first_digit i32)
  (local $second_digit i32)
  (local $byte_val i32)
  (local $byte_idx i32)

  (local.set $sum (i32.const 0))
  (local.set $state (i32.const 0))

  (local.set $first_digit (i32.const -1))
  (local.set $second_digit (i32.const -1))

  ;; Loop over the bytes in the input
  (local.set $byte_idx (i32.const 0))
  (block (loop
    (br_if 1 (i32.ge_u (local.get $byte_idx) (local.get $input_len)))
    ;; (local.set $byte_val (i32.load8_u (i32.add (local.get $input_ptr) (local.get $byte_idx))))

    ;; Process a line every time we see a newline
    (if (i32.eq (local.get $byte_val) (i32.const 10)) (then
      ;; Add the digits to the sum if we have them.
      (if (i32.ge_s (local.get $first_digit) (i32.const 0)) (then
        ;; Add the first digit times 10.
        (local.set $sum (i32.add (local.get $sum) (i32.mul (local.get $first_digit) (i32.const 10))))       
        ;; Add the second digit if we have it.
        (if (i32.ge_s (local.get $second_digit) (i32.const 0))
          (then
            (local.set $sum (i32.add (local.get $sum) (local.get $second_digit)))
          )
          ;; otherwise add the first digit again.
          (else
            (local.set $sum (i32.add (local.get $sum) (local.get $first_digit)))
          )
        )
      ))
      ;; Update state to look for first digit again.
      (local.set $state (i32.const 0))
    ))

    (br 0)
  ))
  (return (local.get $sum))
)