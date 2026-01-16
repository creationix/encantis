#!/usr/bin/env bun

console.log("CLI tool for Encantis");

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log("Usage: cli.ts <command> [options]");
}
console.error("TODO: Implement CLI")