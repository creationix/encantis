-- Add two numbers together.
export func add: (a:i32 b:i32) -> i32 {
    return a + b
}


-- Custom type for 2d point
interface Point: (f32 f32)

-- Distance to a point
export func distance: p:Point -> f32 {
    return sqrt(p.1*p.1 + p.2*p.2)
}

-- Multiple return values using tuple
export func idiv: (a:i32 b:i32) -> (i32 i32) {
    return (a / b, a % b)
}