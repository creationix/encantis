
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

export "xxh32" func (ptr: *u32, len: u32, seed: u32) -> u32
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
      v1 = round32(v1, *ptr)
      ptr += 4
      v2 = round32(v2, *ptr)
      ptr += 4
      v3 = round32(v3, *ptr)
      ptr += 4
      v4 = round32(v4, *ptr)
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
  while ptr + 4 < last do
    h32 += *ptr * prime32-3
    h32 = (h32 <<< 17) * prime32-4
    ptr += 4
  end

  -- Same thing, but without `while` syntax sugar
  block-outer
    loop
      br-if-outer ptr + 4 >= last
      h32 += *ptr * prime32-3
      h32 = (h32 <<< 17) * prime32-4
      ptr += 4
      br
    end
  end

  -- For the remaining bytes that didn't make a whole word,
  -- either 0, 1, 2 or 3 bytes, as 4bytes = 32bits = 1 word.
  while *ptr < last do
    h32 += *(ptr as *u8) & prime32-5
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