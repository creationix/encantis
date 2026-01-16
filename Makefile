.PHONY: all test clean wasm wat ast js check

# Build all examples
all: ast wat wasm

COMPILER_FILES := ./tools/cli.ts # TODO: List all source files here that affect compilation
# List of all .ents files in the examples directory
ALL_ENT_FILES := $(shell find examples -name "*.ents")
# List of all expected ast, wat, wasm files
ALL_AST_FILES := $(patsubst %.ents,%.ast,$(ALL_ENT_FILES))
ALL_WAT_FILES := $(patsubst %.ents,%.wat,$(ALL_ENT_FILES))
ALL_WASM_FILES := $(patsubst %.wat,%.wasm,$(ALL_WAT_FILES))

# Command to check .ents files for errors
ENCANTIS_CHECK = ./tools/cli.ts check
# Command to compile .ents to .ast
ENCANTIS_PARSE = ./tools/cli.ts ast
# Command to compile .ents to .wat
ENCANTIS_COMPILE = ./tools/cli.ts compile

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@find . -name "*.ast" -delete
	@find . -name "*.wasm" -delete
	@find . -name "*.wat" -delete
	@echo "Cleaned .ast, .wasm, and .wat files"

# Check all .ents files for errors without compiling
check:
	@echo "Checking .ents files..."
	@for file in $(ALL_ENT_FILES); do \
		$(ENCANTIS_CHECK) $$file; \
	done

# Generate AST (JSON) from .ents files
ast: $(ALL_AST_FILES)
%.ast: %.ents $(COMPILER_FILES)
	$(ENCANTIS_PARSE) $< -o $@

# Compile .ents files to .wat
wat: $(ALL_WAT_FILES)
%.wat: %.ents $(COMPILER_FILES)
	$(ENCANTIS_COMPILE) $< -o $@

# Compile .wat files to .wasm
wasm: $(ALL_WASM_FILES)
%.wasm: %.wat
	wat2wasm --enable-all $< -o $@
	wasm-opt -all -Os $@ -o $(patsubst %.wasm,%.opt.wasm,$@)
	wasm2wat --enable-all -f --inline-exports --inline-imports $(patsubst %.wasm,%.opt.wasm,$@) -o $(patsubst %.wasm,%.opt.wat,$@)

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

# Help
help:
	@echo "Available targets:"
	@echo "  all       - Build all examples (ast + wat + wasm)"
	@echo "  clean     - Clean build artifacts"
	@echo "  check     - Check .ents files for errors"
	@echo "  ast       - Parse .ents files to .ast (JSON)"
	@echo "  wat       - Compile .ents files to .wat"
	@echo "  wasm      - Compile .wat files to .wasm"
	@echo "  test      - Run all tests"
	@echo "  help      - Show this help"
