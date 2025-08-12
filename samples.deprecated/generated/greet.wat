(module
  ;; Import sys.print: takes a slice (pointer and length) for printing.
  (import "sys" "print" (func $print (param i32 i32)))
  
  ;; Global bump pointer for the allocator, initialized at INITIAL-HEAP-OFFSET.
  (global $heap_ptr (mut i32) (i32.const 16))
  
  ;; Exported malloc function: allocates a block of memory of the given size.
  (func $malloc (export "malloc") (param $size i32) (result i32)
    (local $old_ptr i32)
    global.get $heap_ptr
    local.set $old_ptr
    global.get $heap_ptr
    local.get $size
    i32.add
    global.set $heap_ptr
    local.get $old_ptr
  )
  
  ;; Function concat: concatenates two [u8] slices.
  ;; Parameters:
  ;;   $a_ptr, $a_len: first slice (a)
  ;;   $b_ptr, $b_len: second slice (b)
  ;; Returns:
  ;;   A slice (pointer and length) representing a concatenation of a and b.
  (func $concat
    (param $a_ptr i32) (param $a_len i32)
    (param $b_ptr i32) (param $b_len i32)
    (result i32) (result i32)
    (local $len i32)
    (local $buf i32)
    ;; Compute total length = a.len + b.len.
    local.get $a_len
    local.get $b_len
    i32.add
    local.set $len

    ;; Allocate memory for the concatenated result.
    local.get $len
    call $malloc
    local.set $buf

    ;; Copy the first slice (a) into buf.
    local.get $buf      ;; destination pointer
    local.get $a_ptr    ;; source pointer for a
    local.get $a_len    ;; number of bytes to copy from a
    memory.copy

    ;; Copy the second slice (b) into buf at offset a.len.
    local.get $buf
    local.get $a_len
    i32.add            ;; destination = buf + a.len
    local.get $b_ptr   ;; source pointer for b
    local.get $b_len   ;; number of bytes to copy from b
    memory.copy

    ;; Return the resulting slice: (buf, len)
    local.get $buf
    local.get $len
  )
  
  ;; Exported greet function: accepts a string slice from the host and prints
  ;; the concatenation of the literal "Hello " with the provided message.
  (func (export "greet") (param $msg_ptr i32) (param $msg_len i32)
    ;; Call concat with:
    ;;   a = literal "Hello " (located at offset 0, length 6)
    ;;   b = host provided msg (msg_ptr, msg_len)
    i32.const 0        ;; pointer to "Hello " in data segment
    i32.const 6        ;; length of "Hello " (literal)
    local.get $msg_ptr ;; msg pointer from host
    local.get $msg_len ;; msg length from host
    call $concat       ;; returns two values: pointer and length of the concatenated string
    call $print        ;; print the resulting slice
  )
  
  ;; Define and export the linear memory (one page: 64KiB).
  (memory (export "memory") 1)
  
  ;; Data segment: store the literal "Hello " at offset 0.
  (data (i32.const 0) "Hello ")
)
