Variable length integer encoding with 3 bits of extra type information.

This makes a great base for serializing unstructured data so that it can be self documenting.

```
ttt xxxxx (where xxxxx < 11100)
ttt 11100 xxxxxxxx
ttt 11101 xxxxxxxx xxxxxxxx
ttt 11110 xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx
ttt 11111 xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx
          xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx
```

The types are:

000 - unsigned integer
001 - signed integer
010 - UTF-8 string
011 - byte array
100 - list
101 - dictionary
110 - floating point number
111 - pointer