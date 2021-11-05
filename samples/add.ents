
-- Declare types of imported functions
import "print" func print (String) -> void

-- Interface is a non-unique type.
interface Point: (f32 f32)

-- Unique is a unique type.
type String: [u8]

-<
 | Add two points together, pass points by value.
 | In wasm this is (i32 i32 i32 i32) -> (i32 i32)
 | Return type annotation is optional and will
 | be inferred if omitted.
 >-
func add (a: Point, b: Point)
  => Point(a.1 + b.1, a.2 + b.2)

-- Distance to a point using Point type
func distance (p: Point) -> f32
  => sqrt(p.1 * p.1 + p.2 * p.2)

-- Distance to a point destructuring Point type
func distance (x: f32, y: f32) -> f32
  => sqrt(x * x + y * y)

-< Multiple return values using tuple.
 | No return type annotation needed since it
 | is inferred from code.
 >-
export "idiv" func (a: i32 b: i32) => (a / b, a % b)

-- Block syntax is also allowed for longer functions
export "_start"
func main () -> f32
  print("Hello 🌍🌎🌏")

  local a = Point(1, 2)
  local b = Point(2, 3)

  -- Anonymous functions are also allowed.
  -- The types can all be inferred.
  local add-inline = (a, b) => (a.1 + b.1, a.2 + b.2)
  local c = add-inline(a, b)

  return distance(c)
end

-<
  Given a number and a slice of memory, write out the 
  decimal digits using ASCII encoding.
>-
func digits(num: u32, mem: <u8>) -> (i: u32)
  i = 0
  block-outer
    loop
      br-if-outer num == 0 or i >= mem.len
      mem[i] = num % 10 + '0'
      i += 1
      num /=10
      br
    end
  end
end

func digits(num: u32, mem: <u8>) -> (i: u32)
  i = 0
  while num != 0 and i < mem.len do
    mem[i] = num % 10 + '0'
    i += 1
    num /=10
  end
end


func digits(num: u32, mem: <u8>) -> (i: u32)
  i = 0
  loop
    return-if num == 0 or i >= mem.len
    mem[i] = num % 10 + '0'
    i += 1
    num /=10
    br
  end
end

-- for..in sugar works on integers
-- it iterates from 0 to n-1
func sum (n: u32) -> (s: u32)
  s = 0
  for i in n do
    s += i
  end
end

-- for..in also works on slices
-- it iterates on the values and automatically stops
func iterate (list: <<u8>>)
  for str in list do
    -- str is type <u8>
    for char in str do
      -- char is type u8
    end
  end
end


-- for..in also works on zero terminated arrays
func iterate (list: [[u8]])
  for str in list do
    -- str is type [u8]
    for char in str do
      -- char is type u8
    end
  end
end
