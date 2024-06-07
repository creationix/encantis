all: xxh64.wasm xxh32.wasm

clean:
	rm *.wasm

%.js: %.wasm
	wasm2js $< -o $@

%.wasm: %.wat
	wat2wasm $< -o $@

%.wat: %.ents
	echo "TODO: write encantis compiler"

.PHONY: all clean