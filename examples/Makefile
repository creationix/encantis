.PHONY: all test clean wasm wat js check

# Path to the compiler
ENCANTIS = bun run ../tools/cli.ts

# Build all examples
all: wat wasm

# Compile all .ents files to .wat using the Encantis compiler
wat:
	@echo "Compiling .ents files to .wat..."
	@find . -name "*.ents" -exec bash -c '$(ENCANTIS) compile "$$1" -o "$${1%.ents}.wat" 2>&1 || echo "Failed: $$1"' _ {} \;

# Compile all WAT files to WASM
wasm:
	@echo "Compiling .wat files to .wasm..."
	@find . -name "*.wat" -exec bash -c 'wat2wasm "$$1" -o "$${1%.wat}.wasm"' _ {} \;

# Generate JS glue code from WASM files (for examples that need it)
js:
	@echo "Generating JS from WASM..."
	@find . -name "*.wasm" -exec bash -c 'if [ ! -f "$${1%.wasm}.js" ]; then wasm2js "$$1" -o "$${1%.wasm}.js"; fi' _ {} \;

# Check all .ents files for errors without compiling
check:
	@echo "Checking .ents files..."
	@find . -name "*.ents" -exec bash -c '$(ENCANTIS) check "$$1"' _ {} \;

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
	@cd math/trig && $(ENCANTIS) compile trig.ents -o trig.ents.wat && wat2wasm trig.ents.wat -o trig.ents.wasm && node trig.ents.mjs

test-xxh32:
	@cd crypto/xxh32 && bun test xxh32.test.ts

test-xxh64:
	@cd crypto/xxh64 && bun test xxh64.test.ts

# Compile a single file (usage: make compile FILE=path/to/file.ents)
compile:
	@$(ENCANTIS) compile $(FILE) -o $(FILE:.ents=.wat)
	@wat2wasm $(FILE:.ents=.wat) -o $(FILE:.ents=.wasm)
	@echo "Compiled $(FILE) -> $(FILE:.ents=.wasm)"

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@find . -name "*.wasm" -delete
	@find . -name "*.wat" -delete
	@echo "Cleaned .wasm and .wat files"

# Help
help:
	@echo "Available targets:"
	@echo "  all       - Build all examples (wat + wasm)"
	@echo "  wat       - Compile .ents files to .wat"
	@echo "  wasm      - Compile .wat files to .wasm"
	@echo "  js        - Generate JS from WASM files"
	@echo "  check     - Check .ents files for errors"
	@echo "  test      - Run all tests"
	@echo "  test-*    - Run specific example test"
	@echo "  compile   - Compile a single file (FILE=path/to/file.ents)"
	@echo "  clean     - Clean build artifacts"
	@echo "  help      - Show this help"
