memory mem 1

global prime32-1 = 2654435761U
global prime32-2 = 2246822519U
global prime32-3 = 3266489917U
global prime32-4 =  668265263U
global prime32-5 =  374761393U

global prime64-1 = 11400714785074694791UL
global prime64-2 = 14029467366897019727UL
global prime64-3 =  1609587929392839161UL
global prime64-4 =  9650029242287828579UL
global prime64-5 =  2870177450012600261UL

export "xxh32"
func (ptr: *u32, len: u32, seed: u32) -> u32
  local h32: u32
  local last: u32
  local limit: u32
  local v1: u32
  local v2: u32
  local v3: u32
  local v4: u32
  last = ptr + len

  if len >= 16 then
    limit = last - 16
    v1 = seed + prime32-1 + prime32-2
    v2 = seed + prime32-2
    v3 = seed + 0
    v4 = seed - prime32-1

    -- For every chunk of 4 words, so 4 * 32bits = 16 bytes
    loop
      v1 = round32(v1, ptr.*)
      ptr += 4
      v2 = round32(v2, ptr.*)
      ptr += 4
      v3 = round32(v3, ptr.*)
      ptr += 4
      v4 = round32(v4, ptr.*)
      ptr += 4
      br-if ptr <= limit
    end

    h32 = (v1 <<< 1)
        + (v2 <<< 7)
        + (v3 <<< 12)
        + (v4 <<< 18)

  else -- when input is smaller than 16 bytes
    h32 = seed + prime32-5
  end

  h32 += len

  -- For the remaining words not covered above, either 0, 1, 2 or 3
  while ptr + 4 <= last do
    h32 += ptr.* * prime32-3
    h32 = (h32 <<< 17) * prime32-4
    ptr += 4
  end

  -- For the remaining bytes that didn't make a whole word,
  -- either 0, 1, 2 or 3 bytes, as 4bytes = 32bits = 1 word.
  while ptr < last do
    h32 += ptr.*u8 & prime32-5
    h32 = (h32 <<< 11) * prime32-1
    ptr += 1
  end

  -- Finalise
  h32 ^= h32 >> 15
  h32 *= prime32-2
  h32 ^= h32 >> 13
  h32 *= prime32-3
  h32 ^= h32 >> 16
  h32
end

func round32(seed: i32, value: i32) -> i32
  seed += value * prime32-2
  seed <<<= 13
  seed *= prime32-1
  seed
end

-- This is the actual WebAssembly implementation.
-- It cannot be used directly from JavaScript because of the lack of support
-- for i64.
func xxh64 (ptr: *u64, len: u32, seed: u64) -> (h64: u64)
  local last: *u64
  local limit: u32
  local v1: u64
  local v2: u64
  local v3: u64
  local v4: u64
  last = ptr + len

  if len >= 32

    limit = last - 32
    v1 = seed + prime64-1 + prime64-2
    v2 = seed + prime64-2
    v3 = seed + 0
    v4 = seed - prime64-1

    -- For every chunk of 4 words, so 4 * 64bits = 32 bytes
    loop
      v1 = round64(v1, ptr.*)
      ptr += 8
      v2 = round64(v2, ptr.*)
      ptr += 8
      v3 = round64(v3, ptr.*)
      ptr += 8
      v4 = round64(v4, ptr.*)
      ptr += 8
      br-if ptr <= limit
    end

    h64 = (v1 <<< 1) 
        + (v2 <<< 7)
        + (v3 <<< 12)
        + (v4 <<< 18)

    h64 = merge-round64(h64, v1)
    h64 = merge-round64(h64, v2)
    h64 = merge-round64(h64, v3)
    h64 = merge-round64(h64, v4)
    
  -- when input is smaller than 32 bytes
  else 
    h64 = seed + prime64-5
  end
  
  h64 += len:u64
    
  -- For the remaining words not covered above, either 0, 1, 2 or 3
  while ptr + 8 <= last
    h64 ^= round64(0, ptr.*)
    h64 = (h64 <<< 27) * prime64-1 + prime64-4
    ptr += 8
  end

  -- For the remaining half word. That is when there are more than 32bits
  -- remaining which didn't make a whole word.
  if ptr + 4 <= last
    h64 ^= ptr.*u32 * prime64-1
    h64 = (h64 <<< 23) * prime64-2 + prime64-3
    ptr += 4
  end

  -- For the remaining bytes that didn't make a half a word (32bits),
  -- either 0, 1, 2 or 3 bytes, as 4bytes = 32bits = 1/2 word.
  while ptr < last
    h64 ^= ptr.*u8 * prime64-5
    h64 = (h64 <<< 11) * prime64-1
    ptr += 1
  end
  
  -- Finalise
  h64 ^= h64 >> 33
  h64 *= prime64-2
  h64 ^= h64 >> 29
  h64 *= prime64-3
  h64 ^= h64 >> 32  

end

func round64 (acc: u64, value: u64) -> (acc: u64)
  acc += value * prime64-2
  acc <<<= 31
  acc *= prime64-1
end

func merge-round64 (acc: u64, value: u64) -> (acc: u64)
  value = round64(0, value)
  acc ^= value
  acc = (acc * prime64-1) + prime64-4
end

-- This function can be called from JavaScript and it expects that the
-- first word in the memory is the u64 seed, which is followed by the actual
-- data that is being hashed.
-- `ptr` indicates the beginning of the memory where it's stored (with seed).
-- `len` is the length of the actual data (without the 8bytes for the seed).
-- The function itself doesn't return anything, since the u64 wouldn't work
-- in JavaScript, so instead it is stored in place of the seed.
export "xxh64"
func (ptr: *u64, len: u32) -> void
  ptr.* = xxh64(ptr + 8, len, ptr.*)
end
