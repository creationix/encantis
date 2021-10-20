
-- Declare types of imported functions
import {
    print: String -> void
}

-- Declare types of exported functions
export {
    idiv: (i32 i32) -> (i32 i32)
    main: void -> f32
}

-- Interface is a non-unique type.
interface Point: (f32 f32)

-- Unique is a unique type.
unique String: <u8>

internal {
    add: (Point Point) -> Point
    distance: Point -> f32
}

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
 | No inline type annotations needed since it
 | was defined above in the export block.
 >- 
func idiv (a, b) => (a / b, a % b)

-- Block syntax is also allowed for longer functions
func main ()
    print("Hello 🌍🌎🌏")

    let a = Point(1, 2)
    let b = Point(2, 3)

    -- Anonymous functions are also allowed.
    -- The types can all be inferred.
    let add-inline = (a, b) => (a.1 + b.1, a.2 + b.2)
    let c = add-inline(a, b)

    return distance(c)
end


-<
  Given a number and a slice of memory, write out the decimal
  digits using ASCII encoding.
>-
func digits(num: u32, mem: <u8>) -> u32
    var i = 0
    block
        loop
            br 1 if num == 0 or i >= mem.len
            mem[i] = num % 10 + '0'
            i += 1
            num /=10
            br 0
        end
    end
    return i
end

func digits(num: u32, mem: <u8>) -> u32
    var i = 0
    while num != 0 and i < mem.len do
        mem[i] = num % 10 + '0'
        i += 1
        num /=10
    end
    return i
end


func digits(num: u32, mem: <u8>) -> u32
    var i = 0
    loop
        if num == 0 or i >= mem.len then
            return i
        end
        mem[i] = num % 10 + '0'
        i += 1
        num /=10
        br 0
    end
end

