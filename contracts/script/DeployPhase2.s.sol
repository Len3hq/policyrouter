// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ITapeOutProcessor} from "../src/interfaces/ITapeOut.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {CreditEscrow} from "../src/CreditEscrow.sol";

/// Phase 2 on X Layer mainnet, in two transactions from the deployer:
///   1. deploy PolicyRegistry, bound to the PolicyRouter processor from Phase 1
///   2. deploy CreditEscrow, bound to that registry, with the router and payee fixed
/// Then it checks the wiring and, when broadcasting, adds both addresses to deployments/xlayer.json.
///
/// Every parameter below is permanent once broadcast: neither contract has an admin.
///
/// Dry run (fork, nothing sent):
///   forge script script/DeployPhase2.s.sol --fork-url https://rpc.xlayer.tech --sender $DEPLOYER_ADDRESS
/// Broadcast (asks for the keystore password):
///   forge script script/DeployPhase2.s.sol --rpc-url https://rpc.xlayer.tech \
///     --account policyrouter-deployer --sender $DEPLOYER_ADDRESS --broadcast --slow
contract DeployPhase2 is Script {
    /// From Phase 1 (deployments/xlayer.json).
    ITapeOutProcessor constant PROCESSOR = ITapeOutProcessor(0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99);
    uint256 constant BUDGET_GUARD = 1;
    /// The only address allowed to call CreditEscrow.settle(): the router wallet.
    address constant ROUTER = 0xbFF88F4CBe6723467A1c9BBbF187d8e2aB8FD5f3;

    function run() external {
        require(block.chainid == 196, "not X Layer mainnet");
        address deployer = msg.sender;
        string memory file =
            string.concat(vm.projectRoot(), "/../deployments/", vm.envOr("DEPLOYMENT_OUT", string("xlayer.json")));
        require(
            vm.parseJsonAddress(vm.readFile(file), ".processor") == address(PROCESSOR), "processor mismatch with record"
        );
        // payee receives settled usage fees: the deployer, which is also the treasury's ops address
        address payee = deployer;
        console2.log("deployer        ", deployer);
        console2.log("balance (wei)   ", deployer.balance);

        vm.startBroadcast(deployer);
        PolicyRegistry registry = new PolicyRegistry(PROCESSOR);
        CreditEscrow escrow = new CreditEscrow(registry, ROUTER, payee);
        vm.stopBroadcast();

        require(address(registry.processor()) == address(PROCESSOR), "registry processor");
        require(address(escrow.registry()) == address(registry), "escrow registry");
        require(escrow.router() == ROUTER && escrow.payee() == payee, "escrow roles");
        (uint32 nIn, uint32 nOut,,) = PROCESSOR.circuitInfo(BUDGET_GUARD);
        require(nIn == 6 && nOut == 3, "budget guard visible to registry");

        console2.log("PolicyRegistry  ", address(registry));
        console2.log("CreditEscrow    ", address(escrow));
        console2.log("router          ", ROUTER);
        console2.log("payee           ", payee);
        console2.log("deployer left   ", deployer.balance);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(vm.toString(address(registry)), file, ".policyRegistry");
            vm.writeJson(vm.toString(address(escrow)), file, ".creditEscrow");
            vm.writeJson(vm.toString(ROUTER), file, ".router");
            vm.writeJson(vm.toString(payee), file, ".escrowPayee");
        }
    }
}
