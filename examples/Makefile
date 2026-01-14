.PHONY: all test clean wasm js

# Build all examples
all: wasm js

# Compile all WAT files to WASM
wasm:
	@echo "Compiling WAT files to WASM..."
	@find . -name "*.wat" -exec bash -c 'wat2wasm "$$1" -o "$${1%.wat}.wasm"' _ {} \;

# Generate JS glue code from WASM files (for examples that need it)
js:
	@echo "Generating JS from WASM..."
	@find . -name "*.wasm" -exec bash -c 'if [ ! -f "$${1%.wasm}.js" ]; then wasm2js "$$1" -o "$${1%.wasm}.js"; fi' _ {} \;

# Run all tests
test:
	@echo "Running all tests..."
	@echo "=== Testing trig example ==="
	@cd math/trig && node trig.ents.mjs
	@echo "=== Testing xxh32 example ==="
	@cd crypto/xxh32 && bun test xxh32.test.ts
	@echo "=== Testing xxh64 example ==="
	@cd crypto/xxh64 && bun test xxh64.test.ts
	@echo "All tests completed!"

# Test individual examples
test-trig:
	@cd math/trig && wat2wasm trig.ents.wat && node trig.ents.mjs

test-xxh32:
	@cd crypto/xxh32 && bun test xxh32.test.ts

test-xxh64:
	@cd crypto/xxh64 && bun test xxh64.test.ts

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@find . -name "*.wasm" -not -path "./crypto/xxh*/xxh*.wasm" -delete
	@echo "Cleaned (preserved hand-maintained .wasm files)"

# Help
help:
	@echo "Available targets:"
	@echo "  all      - Build all examples (wasm + js)"
	@echo "  wasm     - Compile WAT files to WASM"
	@echo "  js       - Generate JS from WASM files"
	@echo "  test     - Run all tests"
	@echo "  test-*   - Run specific example test"
	@echo "  clean    - Clean build artifacts"
	@echo "  help     - Show this help"