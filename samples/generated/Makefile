greet: greet.optimized.wasm greet.mjs
	node greet.mjs

%.wasm: %.wat
	wat2wasm $< -o $@

%.optimized.wasm: %.wasm
	wasm-opt --enable-multivalue --enable-bulk-memory -Oz $< -o $@

clean:
	rm *.wasm

.PHONY: greet clean
