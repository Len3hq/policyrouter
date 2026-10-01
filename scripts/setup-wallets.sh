#!/usr/bin/env bash
# Creates the two PolicyRouter wallets in Foundry's encrypted keystore (~/.foundry/keystores).
# Private keys are never printed or written into the repo; you choose a password for each.
#
#   deployer: holds OKB, creates the processor, mints transistors, tapes out circuits, deploys contracts
#   router:   signs receipts and calls CreditEscrow.settle()
#
# Usage: scripts/setup-wallets.sh
set -euo pipefail
mkdir -p "${HOME}/.foundry/keystores"

for name in policyrouter-deployer policyrouter-router; do
  if cast wallet list 2>/dev/null | grep -q "^${name} "; then
    echo "${name} already exists, skipping"
  else
    echo "Creating ${name} (you will be asked for a password)"
    cast wallet new "${HOME}/.foundry/keystores" "${name}" >/dev/null
  fi
  echo "${name}: $(cast wallet address --account "${name}")"
done

echo
echo "Copy the two addresses into .env as DEPLOYER_ADDRESS and ROUTER_ADDRESS."
echo "Then send OKB on X Layer to the deployer. Budget at least 0.05 OKB: processor deploy fee"
echo "0.0066 + per-mint protocol fee 0.00066 + per-tapeout fee 0.0013 + transistors + gas."
echo "The router needs a little OKB for settle() gas."
