// Runtime helpers for wide integers (i128/u128 up to i512/u512).
//
// A wide integer is n i64 values on the stack, least significant first. Each
// operation is a call to a generated helper, `$__w<n>_<op>`, taking the n parts
// of each operand. Calls take their operands straight off the stack, so this
// works whatever the operands are (locals, loads, calls), and the helpers do
// the carries, borrows and cross-limb shifts that per-limb i64 ops can't.

export type WideBinaryOp =
  | 'add' | 'sub' | 'mul'
  | 'and' | 'or' | 'xor'
  | 'shl' | 'shr_u' | 'shr_s' | 'rotl' | 'rotr'
  | 'eq' | 'ne'
  | 'lt_u' | 'lt_s' | 'gt_u' | 'gt_s' | 'le_u' | 'le_s' | 'ge_u' | 'ge_s'
  | 'min_u' | 'min_s' | 'max_u' | 'max_s'

export type WideUnaryOp = 'not' | 'neg' | 'abs'

// Stores a wide value (on the stack after the address) to memory.
export type WideStoreOp = 'store'

// Sign-extends a value of n parts to `to` parts: `sext_<to>`.
export type WideSextOp = `sext_${number}`

export function wideHelperName(n: number, op: WideBinaryOp | WideUnaryOp | WideStoreOp | WideSextOp): string {
  return `$__w${n}_${op}`
}

// A call to the helper for `op`, applied to operands already in WAT form.
export function wideCall(n: number, op: WideBinaryOp | WideUnaryOp | WideSextOp, ...operands: string[]): string {
  return `(call ${wideHelperName(n, op)} ${operands.join(' ')})`
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const params = (name: string, n: number) => range(n).map(i => `(param $${name}${i} i64)`).join(' ')
const results = (n: number) => `(result ${range(n).map(() => 'i64').join(' ')})`
const get = (name: string, i: number) => `(local.get $${name}${i})`
const gets = (name: string, n: number) => range(n).map(i => get(name, i)).join(' ')
const locals = (name: string, n: number) => range(n).map(i => `(local $${name}${i} i64)`).join(' ')

function binaryHelper(n: number, op: WideBinaryOp): string {
  const head = (result: string) => `(func ${wideHelperName(n, op)} ${params('a', n)} ${params('b', n)} ${result}`
  switch (op) {
    case 'and':
    case 'or':
    case 'xor':
      return `${head(results(n))}\n  ${range(n).map(i => `(i64.${op} ${get('a', i)} ${get('b', i)})`).join(' ')}\n)`

    case 'add':
      // r = a + b + carry, limb by limb.
      return `${head(results(n))}
  (local $t i64) (local $c i64) ${locals('r', n)}
  ${range(n).map(i => `(local.set $t (i64.add ${get('a', i)} ${get('b', i)}))
  (local.set $r${i} (i64.add (local.get $t) (local.get $c)))
  (local.set $c (i64.extend_i32_u (i32.or (i64.lt_u (local.get $t) ${get('a', i)}) (i64.lt_u (local.get $r${i}) (local.get $t)))))`).join('\n  ')}
  ${gets('r', n)}
)`

    case 'sub':
      // r = a - b - borrow, limb by limb.
      return `${head(results(n))}
  (local $t i64) (local $c i64) ${locals('r', n)}
  ${range(n).map(i => `(local.set $t (i64.sub ${get('a', i)} ${get('b', i)}))
  (local.set $r${i} (i64.sub (local.get $t) (local.get $c)))
  (local.set $c (i64.extend_i32_u (i32.or (i64.lt_u ${get('a', i)} ${get('b', i)}) (i64.lt_u (local.get $t) (local.get $c)))))`).join('\n  ')}
  ${gets('r', n)}
)`

    case 'mul': {
      // Schoolbook, keeping the low n limbs: r[i+j] += a[i]*b[j], with the high
      // half of each product and the carries going into the next limb.
      const steps: string[] = []
      for (let i = 0; i < n; i++) {
        steps.push('(local.set $c (i64.const 0))')
        for (let j = 0; i + j < n; j++) {
          const k = i + j
          steps.push(`(local.set $lo (i64.mul ${get('a', i)} ${get('b', j)}))
  (local.set $hi (call $__mul_hi ${get('a', i)} ${get('b', j)}))
  (local.set $t (i64.add (local.get $r${k}) (local.get $lo)))
  (local.set $hi (i64.add (local.get $hi) (i64.extend_i32_u (i64.lt_u (local.get $t) (local.get $lo)))))
  (local.set $r${k} (i64.add (local.get $t) (local.get $c)))
  (local.set $c (i64.add (local.get $hi) (i64.extend_i32_u (i64.lt_u (local.get $r${k}) (local.get $t)))))`)
        }
      }
      return `${head(results(n))}
  (local $t i64) (local $c i64) (local $lo i64) (local $hi i64) ${locals('r', n)}
  ${steps.join('\n  ')}
  ${gets('r', n)}
)`
    }

    case 'shl':
    case 'shr_u':
    case 'shr_s': {
      // Shift by b mod (64n) bits: q whole limbs, then s bits across limbs.
      // In wasm an i64 shift by 64 is a shift by 0, so s = 0 is selected out.
      const bits = 64 * n
      const fill = op === 'shr_s' ? `(i64.shr_s ${get('a', n - 1)} (i64.const 63))` : '(i64.const 0)'
      // Limb i of a, or the fill value outside 0..n-1. For shr_s the fill is the
      // sign, so bits shifted in from above the top limb are sign bits.
      const limb = (i: number) => (i >= 0 && i < n ? get('a', i) : fill)
      const out = range(n).map(i => {
        let v = fill
        for (let q = n - 1; q >= 0; q--) {
          const [main, next] = op === 'shl' ? [i - q, i - q - 1] : [i + q, i + q + 1]
          const mainShift = op === 'shl' ? 'i64.shl' : 'i64.shr_u'
          const nextShift = op === 'shl' ? 'i64.shr_u' : 'i64.shl'
          const part = `(i64.or (${mainShift} ${limb(main)} (local.get $s)) (select (${nextShift} ${limb(next)} (i64.sub (i64.const 64) (local.get $s))) (i64.const 0) (i64.ne (local.get $s) (i64.const 0))))`
          v = `(select ${part} ${v} (i64.eq (local.get $q) (i64.const ${q})))`
        }
        return v
      })
      return `${head(results(n))}
  (local $k i64) (local $q i64) (local $s i64)
  (local.set $k (i64.rem_u ${get('b', 0)} (i64.const ${bits})))
  (local.set $q (i64.shr_u (local.get $k) (i64.const 6)))
  (local.set $s (i64.and (local.get $k) (i64.const 63)))
  ${out.join('\n  ')}
)`
    }

    case 'rotl':
    case 'rotr': {
      // rotl: (a << k) | (a >> (64n - k)), with k = b mod 64n. rotr swaps the shifts.
      const bits = 64 * n
      const zeros = range(n - 1).map(() => '(i64.const 0)').join(' ')
      const [by, back]: WideBinaryOp[] = op === 'rotl' ? ['shl', 'shr_u'] : ['shr_u', 'shl']
      return `${head(results(n))}
  (local $k i64)
  (local.set $k (i64.rem_u ${get('b', 0)} (i64.const ${bits})))
  ${wideCall(n, 'or',
    wideCall(n, by, gets('a', n), `(local.get $k) ${zeros}`),
    wideCall(n, back, gets('a', n), `(i64.sub (i64.const ${bits}) (local.get $k)) ${zeros}`))}
)`
    }

    case 'eq':
    case 'ne': {
      const eq = range(n).map(i => `(i64.eq ${get('a', i)} ${get('b', i)})`).reduce((x, y) => `(i32.and ${x} ${y})`)
      return `${head('(result i32)')}\n  ${op === 'eq' ? eq : `(i32.eqz ${eq})`}\n)`
    }

    case 'min_u':
    case 'min_s':
    case 'max_u':
    case 'max_s': {
      // a when it's the lesser (min) or the greater (max), else b.
      const [which, sign] = op.split('_') as ['min' | 'max', 'u' | 's']
      const picksA = wideCall(n, `${which === 'min' ? 'lt' : 'gt'}_${sign}`, gets('a', n), gets('b', n))
      return `${head(results(n))}\n  (if ${results(n)} ${picksA} (then ${gets('a', n)}) (else ${gets('b', n)}))\n)`
    }

    default: {
      // Ordered comparisons: the first differing limb from the top decides.
      // The top limb compares signed for _s; the rest are always unsigned.
      const [rel, sign] = op.split('_') as ['lt' | 'gt' | 'le' | 'ge', 'u' | 's']
      const strict = rel === 'lt' || rel === 'gt' ? rel : rel === 'le' ? 'lt' : 'gt'
      const checks = range(n).reverse().map(i => {
        const cmp = `(i64.${strict}_${i === n - 1 ? sign : 'u'} ${get('a', i)} ${get('b', i)})`
        return `(if (i64.ne ${get('a', i)} ${get('b', i)}) (then (return ${cmp})))`
      })
      const equal = rel === 'le' || rel === 'ge' ? 1 : 0
      return `${head('(result i32)')}\n  ${checks.join('\n  ')}\n  (i32.const ${equal})\n)`
    }
  }
}

function unaryHelper(n: number, op: WideUnaryOp): string {
  const head = `(func ${wideHelperName(n, op)} ${params('a', n)} ${results(n)}`
  if (op === 'not') {
    return `${head}\n  ${range(n).map(i => `(i64.xor ${get('a', i)} (i64.const -1))`).join(' ')}\n)`
  }
  if (op === 'abs') {
    // The sign is the top limb's.
    const negative = `(i64.lt_s ${get('a', n - 1)} (i64.const 0))`
    return `${head}\n  (if ${results(n)} ${negative} (then ${wideCall(n, 'neg', gets('a', n))}) (else ${gets('a', n)}))\n)`
  }
  // neg: 0 - a
  const zeros = range(n).map(() => '(i64.const 0)').join(' ')
  return `${head}\n  ${wideCall(n, 'sub', zeros, gets('a', n))}\n)`
}

function sextHelper(n: number, to: number): string {
  const sign = `(i64.shr_s ${get('a', n - 1)} (i64.const 63))`
  return `(func ${wideHelperName(n, `sext_${to}`)} ${params('a', n)} ${results(to)}
  ${gets('a', n)} ${range(to - n).map(() => sign).join(' ')}
)`
}

function storeHelper(n: number): string {
  return `(func ${wideHelperName(n, 'store')} (param $p i32) ${params('a', n)}
  ${range(n).map(i => `(i64.store offset=${i * 8} (local.get $p) ${get('a', i)})`).join('\n  ')}
)`
}

const HELPER_REF = /\$__w(\d+)_([a-z0-9_]+)\b/g

// The helper functions a module's WAT calls, including the helpers those
// helpers call, as WAT function definitions.
export function wideHelpersFor(wat: string): string[] {
  const done = new Set<string>()
  const out: string[] = []
  const pending = [wat]
  while (pending.length > 0) {
    const text = pending.pop() as string
    for (const m of text.matchAll(HELPER_REF)) {
      const key = `${m[1]}_${m[2]}`
      if (done.has(key)) continue
      done.add(key)
      const n = Number(m[1])
      const op = m[2]
      const def = op === 'store' ? storeHelper(n)
        : op.startsWith('sext_') ? sextHelper(n, Number(op.slice(5)))
        : op === 'not' || op === 'neg' || op === 'abs' ? unaryHelper(n, op)
        : binaryHelper(n, op as WideBinaryOp)
      out.push(def)
      pending.push(def)
    }
  }
  return out
}
