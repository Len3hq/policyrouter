#!/usr/bin/env bash
# Verifies PolicyRouter's own contracts on OKLink (X Layer mainnet), so anyone can read the source
# on the explorer. Needs an OKLink API key: https://www.oklink.com/account/my-api
#
# Usage: OKLINK_API_KEY=... scripts/verify-contracts.sh
# Addresses and constructor arguments come from deployments/xlayer.json and the deploy scripts.
set -euo pipefail
cd "$(dirname "$0")/../contracts"

: "${OKLINK_API_KEY:?set OKLINK_API_KEY}"
URL="https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER"
DEP=../deployments/xlayer.json
get() { python3 -c "import json,sys; print(json.load(open('$DEP'))['$1'])"; }

verify() {
  local addr=$1 contract=$2 args=$3
  echo "== $contract at $addr"
  forge verify-contract "$addr" "$contract" \
    --chain 196 --verifier oklink --verifier-url "$URL" --verifier-api-key "$OKLINK_API_KEY" \
    --constructor-args "$args" --watch
}

# Phase 1: PolicyTreasury (see script/DeployPhase1.s.sol for these values)
STORY="PolicyRouter: the immutable firewall for AI agents. Each circuit is an access and spend policy. Before every AI request the router calls eval(): allow, deny or downgrade. Anyone can re-run the check."
verify "$(get treasury)" src/PolicyTreasury.sol:PolicyTreasury "$(cast abi-encode \
  'constructor(address,address,address,uint16,uint256,string,string,string,uint256,uint256)' \
  "$(get factory)" "$(get deployer)" "$(get deployer)" "$(get opsBps)" "$(get maxGrant)" \
  "$(get name)" "$(get symbol)" "$STORY" "$(get transistorSupply)" "$(get transistorPriceWei)")"

# Phase 2: PolicyRegistry and CreditEscrow
if [ "$(get policyRegistry)" != "0x0000000000000000000000000000000000000000" ]; then
  verify "$(get policyRegistry)" src/PolicyRegistry.sol:PolicyRegistry \
    "$(cast abi-encode 'constructor(address)' "$(get processor)")"
  verify "$(get creditEscrow)" src/CreditEscrow.sol:CreditEscrow \
    "$(cast abi-encode 'constructor(address,address,address)' "$(get policyRegistry)" "$(get router)" "$(get escrowPayee)")"
fi
