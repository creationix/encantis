# Iteration

In encantis there are several types of iteration sugar.  This document shows them with examples of source encantis and the generated wat.

## Integers

The simplest form is `for .. in N` where `N` is a positive integer.  This loops from zero to the one less than the number.

```ents
local sum:i32 = 0
for i:i32 in 10 do
  sum += i
end
```

This compiles to a simple loop in webassembly.

```wat
(local $sum i32)
(local $i i32)
(local.set $sum (i32.const 0))
(local.set $i (i32.const 0))
(block $loop_exit
  (loop $loop_continue
    (br_if $loop_exit (i32.ge_s (local.get $i) (i32.const 10)))
    (local.set $sum (i32.add (local.get $sum) (local.get $i)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $loop_continue)
  )
)
```

## Explicit Integers

Sometimes you don't want to start at 0 or you want to iterate by something other than 1.  The more explicit syntax comes in handy here.

```ents
local sum:i32 = 0
for i:i32 in (10,1,-1) do
  sum += i
end
```

This will have a sum 10 greater than the previous example since it iterates 10, 9, 8, 7, 6, 5, 4, 3, 2, 1 instead of 0, 1, 2, 3, 4, 5, 6, 7, 8, 9.

The generated wat is as expected.

```wat
(local $sum i32)
(local $i i32)
(local.set $sum (i32.const 0))
(local.set $i (i32.const 10))
(block $loop_exit
  (loop $loop_continue
    (br_if $loop_exit (i32.lt_s (local.get $i) (i32.const 1)))
    (local.set $sum (i32.add (local.get $sum) (local.get $i)))
    (local.set $i (i32.sub (local.get $i) (i32.const 1)))
    (br $loop_continue)
  )
)
```

## Slices

```ents
local message:[u8] = "Hello World"
local sum:i32 = 0
for c:u8 in message do
  sum += c
end
```

The string literal `"Hello World"` gets embedded into the data segment as UTF-8 bytes during compilation.  Let's assume it got inserted at offset zero.

```wat
(data (i32.const 0) "Hello World")
```

Then in our function `message.ptr` is `0` and `message.len` is `11` for the 11 characters.

This gets compiled to:

```wat
(local $message_ptr i32)
(local $message_len i32)
(local.set $message_ptr (i32.const 0))
(local.set $message_len (i32.const 11))
```

The iteration then loops over the bytes in the slice

```wat
(local $sum i32)
(local $current_ptr i32)
(local $end_ptr i32)
(local.set $sum (i32.const 0))
(local.set $current_ptr (local.get $message_ptr))
(local.set $end_ptr (i32.add (local.get $message_ptr) (local.get $message_len)))
(block $loop_exit
  (loop $loop_continue
    (br_if $loop_exit (i32.ge_u (local.get $current_ptr) (local.get $end_ptr)))
    (local.set $sum
      (i32.add
        (local.get $sum)
        (i32.load8_u (local.get $current_ptr))
      )
    )
    (local.set $current_ptr (i32.add (local.get $current_ptr) (i32.const 1)))
    (br $loop_continue)
  )
)
```

## Slices with Indexes

If two values are given, the loop can have access to the iteration index

```ents
local message:[u8] = "Hello World"
local sum:i32 = 0
for (i:i32, c:u8) in message do
  sum += c + i
end
```

This has the same data section and `message_*` initialization as before, but the loop now tracks iteration count as well.

```wat
(local $sum i32)
(local $i i32)
(local $current_ptr i32)
(local $end_ptr i32)
(local.set $sum (i32.const 0))
(local.set $i (i32.const 0))
(local.set $current_ptr (local.get $message_ptr))
(local.set $end_ptr (i32.add (local.get $message_ptr) (local.get $message_len)))
(block $loop_exit
  (loop $loop_continue
    (br_if $loop_exit (i32.ge_u (local.get $current_ptr) (local.get $end_ptr)))
    (local.set $sum
      (i32.add
        (local.get $sum)
        (i32.add
          (i32.load8_u (local.get $current_ptr))
          (local.get $i)
        )
      )
    )
    (local.set $current_ptr (i32.add (local.get $current_ptr) (i32.const 1)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $loop_continue)
  )
)
```

## Fixed Length Slices

```ents
local message:[u8*11] = "Hello World"
local sum:i32 = 0
for c:u8 in message do
  sum += c
end
```

In this version `message` is simply a single pointer and the length is a compile-time constant from the type.

```wat
(local $message_ptr i32)
(local.set $message_ptr (i32.const 0))
```

The iteration code is slightly simpler as well.

```wat
(local $sum i32)
(local $current_ptr i32)
(local $end_ptr i32)
(local.set $sum (i32.const 0))
(local.set $current_ptr (local.get $message_ptr))
(local.set $end_ptr (i32.add (local.get $message_ptr) (i32.const 11)))
(block $loop_exit
  (loop $loop_continue
    (br_if $loop_exit (i32.ge_u (local.get $current_ptr) (local.get $end_ptr)))
    (local.set $sum
      (i32.add (local.get $sum) (i32.load8_u (local.get $current_ptr)))
    )
    (local.set $current_ptr (i32.add (local.get $current_ptr) (i32.const 1)))
    (br $loop_continue)
  )
)
```

## Fixed Length Slices with Indexes

Just like with normal slices, you can iterate with indexes on fixed length slices as well.

```ents
local message:[u8*11] = "Hello World"
local sum:i32 = 0
for (i:i32, c:u8) in message do
  sum += c + i
end
```

The generated code is what you would expect.

## Null Terminated Slices

Sometimes you want or need to to use C style null termination.

```ents
local message:[u8/0] = "Hello World"
local sum:i32 = 0
for c:u8 in message do
  sum += c
end
```

This will generate slightly differently in the data section since it needs to include the null byte.

```wat
(data (i32.const 0) "Hello World\00")
```

Then when initializing `message`, we set just `.ptr` like before.  The length is unknown till we iterate over the bytes.

```wat
(local $message_ptr i32)
(local.set $message_ptr (i32.const 0))
```

The iteration is similar, but has a different conditional looking for the null byte.

```wat
(local $message_ptr i32)
(local $sum i32)
(local $current_ptr i32)
(local $c i32)
(local.set $sum (i32.const 0))
(local.set $current_ptr (local.get $message_ptr))
(block $loop_exit
  (loop $loop_continue
    (local.set $c (i32.load8_u (local.get $current_ptr)))
    (br_if $loop_exit (i32.eqz (local.get $c)))
    (local.set $sum (i32.add (local.get $sum) (local.get $c)))
    (local.set $current_ptr (i32.add (local.get $current_ptr) (i32.const 1)))
    (br $loop_continue)
  )
)
```

## Null Terminated Slices with Slices

As other slice iteration syntaxes, this also supports indexes.

```ents
local message:[u8/0] = "Hello World"
local sum:i32 = 0
for (i:i32, c:u8) in message do
  sum += c + i
end
```

The generated code it what you would expect.
