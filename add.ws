
-- Declare types of imported functions
import {
    print: String -> void
}

-- Declare types of exported functions
export {
    idiv: (i32 i32) -> (i32 i32)
    main: void -> f32
}

-- Optional external type annotations
-- for internal functions
internal {
    add: (Point Point) -> Point
    distance: Point -> f32
}

-- Interface is a non-unique type, anything matching
-- this structure can be used instead.
interface Point: (f32 f32)
-- Type is a unique type, other char slices must
-- be typecast before they can match this.
type String: <u8>

-- Add two points together.
func add (a: Point, b: Point)
    => Point(a.1 + b.1, a.2 + b.2)

-- Distance to a point
-- Inline type annotations can be used.
func distance (x: i32, y: i32) 
    => sqrt(x * x + y * y)

-- Distance to a point using Point type
func distance (p: Point)
    => sqrt(p.1 * p.1 + p.2 * p.2)

-- Multiple return values using tuple
-- No inline type annotations needed since it was
-- defined above in the export block.
func idiv (a, b) => (a / b, a % b)

-- Block syntax is also allowed for longer functions
func main ()
    print("Hello 🌍🌎🌏")
    let add = (a, b) => (a.1 + b.1, a.2 + b.2)
    let a = Point(1, 2)
    let b = Point(2, 3)
    return distance(a + b)
end

