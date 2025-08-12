greet: greet.wasm greet.mjs
	node greet.mjs

%.unopt.wasm: %.wat
	wat2wasm $< -o $@

%.wasm: %.unopt.wasm
	wasm-opt --enable-multivalue --enable-bulk-memory -Oz $< -o $@

clean:
	rm *.wasm

.PHONY: greet clean
