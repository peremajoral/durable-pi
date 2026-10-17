# The 32 pi-durable examples, run against the published packages.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/pi-durable-examples"

# List examples commands
[default]
default:
    @just --list examples

# Install dependencies (published chord + pi-ai + pi-durable)
install:
    npm install --no-audit --no-fund

# Run all 32 examples, each in its own process
run:
    node _run.mjs

# Run one example by name, e.g. just examples one 13-recovery
one NAME:
    npx tsx {{ NAME }}.ts

# Re-download the 32 examples and rewrite their imports to the public subpaths
fetch:
    node fetch-examples.mjs
