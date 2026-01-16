(module
  (type (;0;) (func (param i32 i32) (result i32)))
  (type (;1;) (func (param i32 i32 i32) (result i32)))
  (func (;0;) (type 0) (param i32 i32) (result i32)
    (i32.mul
      (i32.rotl
        (i32.add
          (local.get 0)
          (i32.mul
            (local.get 1)
            (i32.const -2048144777)))
        (i32.const 13))
      (i32.const -1640531535)))
  (func (;1;) (export "xxh32") (type 1) (param i32 i32 i32) (result i32)
    (local i32 i32 i32 i32)
    (local.set 3
      (i32.add
        (local.get 0)
        (local.get 1)))
    (local.set 2
      (i32.add
        (local.get 1)
        (if (result i32)  ;; label = @1
          (i32.ge_s
            (local.get 1)
            (i32.const 16))
          (then
            (local.set 1
              (i32.add
                (local.get 2)
                (i32.const 606290984)))
            (local.set 4
              (i32.sub
                (local.get 2)
                (i32.const 2048144777)))
            (local.set 5
              (i32.add
                (local.get 2)
                (i32.const 1640531535)))
            (local.set 6
              (i32.sub
                (local.get 3)
                (i32.const 16)))
            (loop  ;; label = @2
              (local.set 1
                (call 0
                  (local.get 1)
                  (i32.load
                    (local.get 0))))
              (local.set 4
                (call 0
                  (local.get 4)
                  (i32.load
                    (local.tee 0
                      (i32.add
                        (local.get 0)
                        (i32.const 4))))))
              (local.set 2
                (call 0
                  (local.get 2)
                  (i32.load
                    (local.tee 0
                      (i32.add
                        (local.get 0)
                        (i32.const 4))))))
              (local.set 5
                (call 0
                  (local.get 5)
                  (i32.load
                    (local.tee 0
                      (i32.add
                        (local.get 0)
                        (i32.const 4))))))
              (br_if 0 (;@2;)
                (i32.ge_s
                  (local.get 6)
                  (local.tee 0
                    (i32.add
                      (local.get 0)
                      (i32.const 4))))))
            (i32.add
              (i32.add
                (i32.add
                  (i32.rotl
                    (local.get 1)
                    (i32.const 1))
                  (i32.rotl
                    (local.get 4)
                    (i32.const 7)))
                (i32.rotl
                  (local.get 2)
                  (i32.const 12)))
              (i32.rotl
                (local.get 5)
                (i32.const 18))))
          (else
            (i32.add
              (local.get 2)
              (i32.const 374761393))))))
    (loop  ;; label = @1
      (if  ;; label = @2
        (i32.eqz
          (i32.lt_s
            (local.get 3)
            (local.tee 1
              (i32.add
                (local.get 0)
                (i32.const 4)))))
        (then
          (local.set 2
            (i32.mul
              (i32.rotl
                (i32.add
                  (local.get 2)
                  (i32.mul
                    (i32.load
                      (local.get 0))
                    (i32.const -1028477379)))
                (i32.const 17))
              (i32.const 668265263)))
          (local.set 0
            (local.get 1))
          (br 1 (;@1;)))))
    (loop  ;; label = @1
      (if  ;; label = @2
        (i32.eqz
          (i32.ge_s
            (local.get 0)
            (local.get 3)))
        (then
          (local.set 2
            (i32.mul
              (i32.rotl
                (i32.add
                  (local.get 2)
                  (i32.mul
                    (i32.load8_u
                      (local.get 0))
                    (i32.const 374761393)))
                (i32.const 11))
              (i32.const -1640531535)))
          (local.set 0
            (i32.add
              (local.get 0)
              (i32.const 1)))
          (br 1 (;@1;)))))
    (i32.xor
      (i32.shr_s
        (local.tee 0
          (i32.mul
            (i32.xor
              (i32.shr_s
                (local.tee 0
                  (i32.mul
                    (i32.xor
                      (local.get 2)
                      (i32.shr_s
                        (local.get 2)
                        (i32.const 15)))
                    (i32.const -2048144777)))
                (i32.const 13))
              (local.get 0))
            (i32.const -1028477379)))
        (i32.const 16))
      (local.get 0)))
  (memory (;0;) (export "mem") 1))
