#!/usr/bin/env bash
# Build the deployable wasm into contract/res/.
# nearcore (2.6.x sandbox) rejects some wasm features newer rustc enables by
# default, so we lower the module to MVP features with binaryen's wasm-opt.
# (`cargo near build` from cargo-near is the official alternative.)
set -euo pipefail
cd "$(dirname "$0")"
cargo build --target wasm32-unknown-unknown --release
mkdir -p res
npx -y -p binaryen@132 wasm-opt target/wasm32-unknown-unknown/release/nearjev_policy_vault.wasm \
  -Oz --signext-lowering --mvp-features -o res/nearjev_policy_vault.wasm
ls -la res/nearjev_policy_vault.wasm
sha256sum res/nearjev_policy_vault.wasm
