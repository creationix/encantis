
import {
    print: String -> void
}

export {
    idiv: (i32 i32) -> (i32 i32)
    main: void -> f32
}

internal {
    add: (Point Point) -> Point
    distance: Point -> f32
}

type Point: (f32 f32)
type String: <u8>

-- Add two points together.
func add (a, b) => (a.1 + b.1, a.2 + b.2)

-- Distance to a point
func distance (x, y) => sqrt(x * x + y * y)

-- Multiple return values using tuple
func idiv (a, b) => (a / b, a % b)

func main ()
    print("Hello 🌍🌎🌏")
    let add = (a, b) => (a.1 + b.1, a.2 + b.2)
    let a = Point(1, 2)
    let b = Point(2, 3)
    return distance(a + b)
end

