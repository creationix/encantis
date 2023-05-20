(module
    ;; (import "spectest" "memory" (memory 1 2))
    ;; (export "memory" (memory 0))
  (import "a" "b" (memory 1)) 
  (export "c" (memory 0))
)