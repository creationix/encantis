# Makefile - Backwards Compatibility Layer
# ============================================
# The primary build system is now BUN-based and cross-platform.
# This Makefile provides compatibility wrappers for existing make targets.
# 
# For Windows users: Use `bun run <script>` directly from package.json
# For Unix/Linux/macOS users: Use either `bun run <script>` or `make <target>`
#
# All build scripts are defined in package.json and implemented in TypeScript.
# See package.json "scripts" section for the complete list.

.PHONY: all build watch clean check test help

# Build all examples (parse → compile → wasm)
all:
	bun run examples:all

# Build all packages
build:
	bun run build

# Watch all packages for changes
watch:
	bun run watch

# Clean build artifacts and dist directories
clean:
	bun run examples:clean

# Check all .ents files for errors
check:
	bun run examples:check

# Run all tests
test:
	bun test

# Show this help
help:
	@echo "Encantis Build System - Backwards Compatibility"
	@echo "=============================================="
	@echo ""
	@echo "Primary interface: bun run <script>"
	@echo "Examples:"
	@echo "  bun run examples:all      - Build all examples"
	@echo "  bun run examples:check    - Check .ents files for errors"
	@echo "  bun run examples:clean    - Clean build artifacts"
	@echo "  bun run build             - Build all packages"
	@echo "  bun run watch             - Watch packages for changes"
	@echo "  bun test                  - Run all tests"
	@echo ""
	@echo "Backwards compatibility with make:"
	@echo "  make all                  - Builds all examples"
	@echo "  make build                - Builds all packages"
	@echo "  make clean                - Cleans artifacts"
	@echo "  make check                - Checks .ents files"
	@echo "  make test                 - Runs tests"
	@echo "  make help                 - Shows this message"
