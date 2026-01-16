.PHONY: all test clean wasm wat ast js check

# Path to the compiler
ENCANTIS = ../tools/cli.ts

# Build all examples
all: ast wat wasm

ALL_ENT_FILES := $(shell find . -name "*.ents")
ALL_AST_FILES := $(patsubst %.ents,%.ast,$(ALL_ENT_FILES))
ALL_WAT_FILES := $(patsubst %.ents,%.wat,$(ALL_ENT_FILES))
ALL_WASM_FILES := $(patsubst %.wat,%.wasm,$(ALL_WAT_FILES))

# Generate AST (JSON) from .ents files
ast: $(ALL_AST_FILES)
%.ast: %.ents
	$(ENCANTIS) ast $< -o $@

# Compile .ents files to .wat
wat: $(ALL_WAT_FILES)
%.wat: %.ents
	$(ENCANTIS) compile $< -o $@

# Compile .wat files to .wasm
wasm: $(ALL_WASM_FILES)
%.wasm: %.wat
	wat2wasm $< -o $@
	wasm-opt -all -Os $@ -o $(patsubst %.wasm,%.opt.wasm,$@)

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
	@find . -name "*.ast" -delete
	@find . -name "*.wasm" -delete
	@find . -name "*.wat" -delete
	@echo "Cleaned .ast, .wasm, and .wat files"

# Help
help:
	@echo "Available targets:"
	@echo "  all       - Build all examples (ast + wat + wasm)"
	@echo "  ast       - Parse .ents files to .ast (JSON)"
	@echo "  wat       - Compile .ents files to .wat"
	@echo "  wasm      - Compile .wat files to .wasm"
	@echo "  js        - Generate JS from WASM files"
	@echo "  check     - Check .ents files for errors"
	@echo "  test      - Run all tests"
	@echo "  test-*    - Run specific example test"
	@echo "  compile   - Compile a single file (FILE=path/to/file.ents)"
	@echo "  clean     - Clean build artifacts"
	@echo "  help      - Show this help"
