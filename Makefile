.PHONY: test clean

wasm:
	$(MAKE) -C examples wasm

test:
	$(MAKE) -C examples test

clean:
	$(MAKE) -C examples clean
