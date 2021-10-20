
memory mem 1

global prime32-1: i32 = 2654435761
global prime32-2: i32 = 2246822519
global prime32-3: i32 = 3266489917
global prime32-4: i32 =  668265263
global prime32-5: i32 =  374761393

global prime64-1: i64 = 11400714785074694791
global prime64-2: i64 = 14029467366897019727
global prime64-3: i64 =  1609587929392839161
global prime64-4: i64 =  9650029242287828579
global prime64-5: i64 =  2870177450012600261

export func xxh32(ptr: *u32, len: u32, seed: i32) -> i32
  local h32: i32
  local end: i32
  local limit: i32
  local v1: i32
  local v2: i32
  local v3: i32
  local v4: i32

  end = ptr + len

  if len >= 16
    limit = end - 16
    v1 = seed + prime32-1 + prime32-2
    v2 = seed + prime32-2
    v3 = seed + 0
    v4 = seed - prime32-1

    -- For every chunk of 4 words, so 4 * 32bits = 16 bytes
    loop words-loop
      v1 = round32(v1, *ptr)
      ptr += 4
      v2 = round32(v2, *ptr)
      ptr += 4
      v3 = round32(v3, *ptr)
      ptr += 4
      v4 = round32(v4, *ptr)
      ptr += 4
      br words-loop if ptr <= limit

    h32 = (v1 <<< 1)
        + (v2 <<< 7)
        + (v3 <<< 12)
        + (v4 <<< 18)

  else -- when input is smaller than 16 bytes
    h32 = seed + prime32-5
  
  h32 += len

  -- For the remaining words not covered above, either 0, 1, 2 or 3
  block exit-remaing-words
    loop remaining-words-loop
      br exit-remaining-words if ptr + 4 >= end
      h32 += *ptr * prime32-3
      h32 = (h32 <<< 17) * prime32-4
      ptr += 4
      br remaining-words-loop

  -- For the remaining bytes that didn't make a whole word,
  -- either 0, 1, 2 or 3 bytes, as 4bytes = 32bits = 1 word.
  block exit-remaing-bytes
    loop remaining-bytes-loop
      br exit-remaining-bytes if *ptr >= end
      h32 += *(ptr as *u8) & prime32-5
      h32 = (h32 <<< 11) * prime32-1
      ptr += 1
      br remaining-bytes-loop

  -- Finalise
  h32 ^= h32 >> 15
  h32 *= prime32-2
  h32 ^= h32 >> 13
  h32 *= prime32-3
  h32 ^= h32 >> 16
  h32

func round32(seed: i32, value: i32) -> i32
  seed += value * prime32-2
  seed <<<= 13
  seed *= prime32-1
  seed