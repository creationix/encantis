# Crit-Bit Trees

A crit-bit tree is a binary trie optimized for storing strings or binary keys. The name comes from "critical bit" - the first bit position where two keys differ.

## The Core Idea

Instead of storing keys character-by-character like a regular trie, a crit-bit tree only stores the **bit positions that matter** - the positions where keys actually differ from each other.

```
Regular Trie (stores every character):

         (root)
        /      \
       a        b
      / \        \
     p   r        a
    /     \        \
   e       t        t
  "ape"  "art"    "bat"

Crit-Bit Tree (stores only decision points):

         [bit 6]              <- "which bit distinguishes 'a' from 'b'?"
        /       \
    [bit 14]    "bat"         <- "which bit distinguishes 'ape' from 'art'?"
    /      \
  "ape"   "art"
```

The crit-bit tree has fewer nodes and each internal node is tiny (just a bit position).

## Node Types

A crit-bit tree has exactly two kinds of nodes:

```
Internal Node                    External Node (Leaf)
┌─────────────────┐             ┌─────────────────┐
│ crit_bit: u32   │             │ key: bytes      │
│ left:  *Node    │             │                 │
│ right: *Node    │             │                 │
└─────────────────┘             └─────────────────┘

- Stores bit position           - Stores actual key
- Has two children              - No children
- left = bit is 0               - Terminal node
- right = bit is 1
```

For n keys, there are exactly:

- n external nodes (one per key)
- n-1 internal nodes (one per decision point)

## Bit Numbering

Bits are numbered from the most significant bit (MSB) of the first byte:

```
Key: "ab" = 0x61 0x62

Byte 0 (0x61 = 'a'):          Byte 1 (0x62 = 'b'):
┌─┬─┬─┬─┬─┬─┬─┬─┐            ┌─┬─┬─┬─┬─┬─┬─┬─┐
│0│1│1│0│0│0│0│1│            │0│1│1│0│0│0│1│0│
└─┴─┴─┴─┴─┴─┴─┴─┘            └─┴─┴─┴─┴─┴─┴─┴─┘
 0 1 2 3 4 5 6 7              8 9 ...       15

Bit 0 = MSB of byte 0
Bit 7 = LSB of byte 0
Bit 8 = MSB of byte 1
...
```

To extract bit at position `pos`:

```
byte_index = pos / 8
bit_index  = 7 - (pos % 8)
bit_value  = (key[byte_index] >> bit_index) & 1
```

## Finding the Critical Bit

When inserting a new key, we need to find where it first differs from existing keys:

```
Key A: "cat" =  0x63     0x61     0x74
Key B: "car" =  0x63     0x61     0x72
              └─same─┘ └─same─┘ └─differ!

Byte-by-byte comparison:
  Byte 0: 0x63 XOR 0x63 = 0x00 (no difference)
  Byte 1: 0x61 XOR 0x61 = 0x00 (no difference)
  Byte 2: 0x74 XOR 0x72 = 0x06 (difference!)

0x74 = 0111 0100
0x72 = 0111 0010
XOR  = 0000 0110
            ^
            First differing bit at position 21 (bit 5 of byte 2)
```

## Example: Building a Tree

Let's insert keys "a", "aa", "b" step by step.

### Step 1: Insert "a"

```
Tree with one key:

    "a"           <- just a leaf
```

### Step 2: Insert "aa"

Find critical bit between "a" and "aa":

```
"a"  = 0x61 (then implicit null/end)
"aa" = 0x61 0x61

The difference is at byte 1 (second byte exists vs doesn't).
Critical bit = 8 (first bit of byte 1)

For "a":  bit 8 is implicitly 0 (no byte there, treat as 0)
For "aa": bit 8 is 0 (MSB of 0x61)

Wait - both are 0! Let's look further:
  bit 9:  "a"=0, "aa"=1  <- first difference!

Critical bit = 9
```

```
Tree after inserting "aa":

       [bit 9]
       /     \
     "a"    "aa"

Left child: bit 9 = 0 → "a" (no second byte, treat as 0)
Right child: bit 9 = 1 → "aa" (0x61 has bit 9 = 1)
```

### Step 3: Insert "b"

Find critical bit between "b" and nearest existing key:

```
"a" = 0x61 = 0110 0001
"b" = 0x62 = 0110 0010
             ─────────
XOR        = 0000 0011
                    ^
First difference at bit 6

"b" has bit 6 = 1
"a" has bit 6 = 0
```

Since bit 6 < bit 9, the new internal node goes above the existing tree:

```
Tree after inserting "b":

         [bit 6]
        /       \
    [bit 9]     "b"
    /     \
  "a"    "aa"

Traversal for "a":  bit 6=0 → left, bit 9=0 → left  → "a"  ✓
Traversal for "aa": bit 6=0 → left, bit 9=1 → right → "aa" ✓
Traversal for "b":  bit 6=1 → right                 → "b"  ✓
```

## Lookup Algorithm

To find if a key exists:

```
func contains(tree, search_key):
    node = tree.root

    // Phase 1: Walk down testing bits
    while node is internal:
        bit = get_bit(search_key, node.crit_bit)
        if bit == 0:
            node = node.left
        else:
            node = node.right

    // Phase 2: Verify the candidate
    // (we might have walked to wrong leaf if key doesn't exist)
    return node.key == search_key
```

### Lookup Example: Search for "aa"

```
         [bit 6]
        /       \
    [bit 9]     "b"
    /     \
  "a"    "aa"

Search key: "aa" = 0x61 0x61

Step 1: At [bit 6]
  - bit 6 of "aa" = 0
  - Go LEFT

Step 2: At [bit 9]
  - bit 9 of "aa" = 1
  - Go RIGHT

Step 3: At leaf "aa"
  - Compare "aa" == "aa"
  - Found! ✓
```

### Lookup Example: Search for "ab" (not in tree)

```
Search key: "ab" = 0x61 0x62

Step 1: At [bit 6]
  - bit 6 of "ab" = 0
  - Go LEFT

Step 2: At [bit 9]
  - bit 9 of "ab" = 1  (0x62 = 0110 0010, bit 1 = 1)
  - Go RIGHT

Step 3: At leaf "aa"
  - Compare "ab" == "aa"
  - Not equal → Not found
```

The tree guided us to "aa", but final comparison reveals "ab" isn't in the tree.

## Insert Algorithm

```
func insert(tree, new_key):
    if tree.root is null:
        tree.root = make_leaf(new_key)
        return

    // Phase 1: Find best candidate leaf
    node = tree.root
    while node is internal:
        bit = get_bit(new_key, node.crit_bit)
        node = (bit == 0) ? node.left : node.right

    candidate = node.key

    // Phase 2: Find critical bit
    crit_bit = find_first_differing_bit(new_key, candidate)
    if crit_bit == -1:
        return  // Key already exists

    // Phase 3: Find insertion point
    // Walk down again, stop when we find a node with crit_bit > our crit_bit
    parent = null
    node = tree.root
    while node is internal AND node.crit_bit < crit_bit:
        parent = node
        bit = get_bit(new_key, node.crit_bit)
        node = (bit == 0) ? node.left : node.right

    // Phase 4: Insert new internal node
    new_leaf = make_leaf(new_key)
    new_bit = get_bit(new_key, crit_bit)

    if new_bit == 0:
        new_internal = make_internal(crit_bit, new_leaf, node)
    else:
        new_internal = make_internal(crit_bit, node, new_leaf)

    // Link new internal node to parent
    if parent is null:
        tree.root = new_internal
    elif parent.left == node:
        parent.left = new_internal
    else:
        parent.right = new_internal
```

## Delete Algorithm

```
func delete(tree, key):
    // Phase 1: Find the key (tracking parent and grandparent)
    grandparent = null
    parent = null
    node = tree.root

    while node is internal:
        grandparent = parent
        parent = node
        bit = get_bit(key, node.crit_bit)
        node = (bit == 0) ? node.left : node.right

    if node.key != key:
        return false  // Key not found

    // Phase 2: Remove leaf and its parent internal node
    if parent is null:
        // Deleting only node in tree
        tree.root = null
        return true

    // Get sibling (the other child of parent)
    sibling = (parent.left == node) ? parent.right : parent.left

    // Replace parent with sibling
    if grandparent is null:
        tree.root = sibling
    elif grandparent.left == parent:
        grandparent.left = sibling
    else:
        grandparent.right = sibling

    return true
```

### Delete Example: Remove "a"

```
Before:                          After:
         [bit 6]                      [bit 6]
        /       \                    /       \
    [bit 9]     "b"               "aa"      "b"
    /     \
  "a"    "aa"

Removing "a":
1. Find "a" (left, left)
2. Parent is [bit 9], sibling is "aa"
3. Replace [bit 9] with "aa"
```

## Properties

**Time Complexity:**

- Lookup: O(k) where k = key length in bits
- Insert: O(k)
- Delete: O(k)

**Space:**

- n leaves + (n-1) internal nodes
- Internal nodes are tiny (just bit position + 2 pointers)

**Ordering:**

- In-order traversal gives keys in lexicographic order
- Enables efficient prefix search and range queries

## Comparison with Other Structures

```
┌────────────────┬───────────┬───────────┬─────────────┐
│ Structure      │ Lookup    │ Insert    │ Memory      │
├────────────────┼───────────┼───────────┼─────────────┤
│ Hash Table     │ O(1) avg  │ O(1) avg  │ Higher      │
│ Balanced BST   │ O(log n)  │ O(log n)  │ Per-node    │
│ Trie           │ O(k)      │ O(k)      │ Very high   │
│ Crit-Bit Tree  │ O(k)      │ O(k)      │ Compact     │
└────────────────┴───────────┴───────────┴─────────────┘

k = key length, n = number of keys

Crit-bit advantages:
- Deterministic O(k) (no hash collisions, no rebalancing)
- Memory efficient (small internal nodes)
- Ordered traversal
- Excellent for prefix matching
```

## Implementation Notes

### Pointer Tagging

To distinguish internal from external nodes without extra memory, use pointer tagging:

```
External node pointer: set low bit to 1
Internal node pointer: low bit is 0 (naturally aligned)

func is_external(ptr):
    return (ptr & 1) == 1

func untag(ptr):
    return ptr & ~1
```

### Handling Key Length

When comparing keys of different lengths, treat missing bytes as 0x00:

```
"a"   vs "aa"
0x61     0x61 0x61

Compare as:
0x61 0x00  vs  0x61 0x61
     ^              ^
     These differ at bit 9
```

### Empty Keys

The empty string "" can be handled specially, or treated as having all bits = 0.

## References

- D.J. Bernstein's crit-bit paper: <https://cr.yp.to/critbit.html>
- Adam Langley's implementation: <https://github.com/agl/critbit>
