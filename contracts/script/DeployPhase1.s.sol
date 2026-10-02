// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ITapeOutFactory, ITapeOutProcessor, ITapeOutTransistors} from "../src/interfaces/ITapeOut.sol";
import {PolicyTreasury} from "../src/PolicyTreasury.sol";

/// Phase 1 on X Layer mainnet, in three transactions from the deployer:
///   1. deploy PolicyTreasury, which creates the PolicyRouter processor through the TapeOut factory
///   2. mint exactly the transistors Budget Guard needs
///   3. tape out circuits/budget-guard.json
/// Then it checks eval() against the truth table for all 64 inputs and, when broadcasting,
/// writes deployments/xlayer.json.
///
/// Every parameter below is permanent once broadcast.
///
/// Dry run (fork, nothing sent):
///   forge script script/DeployPhase1.s.sol --fork-url https://rpc.xlayer.tech --sender $DEPLOYER_ADDRESS
/// Broadcast (asks for the keystore password):
///   forge script script/DeployPhase1.s.sol --rpc-url https://rpc.xlayer.tech \
///     --account policyrouter-deployer --sender $DEPLOYER_ADDRESS --broadcast --slow
contract DeployPhase1 is Script {
    ITapeOutFactory constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    /// Any live processor; TAPEOUT_FEE is read from it before ours exists, for the balance check.
    ITapeOutProcessor constant REFERENCE_PROCESSOR = ITapeOutProcessor(0xA93E807fAB41431827EBBa57443Fb687a95E2AA3);

    // --- permanent processor parameters ---
    string constant NAME = "PolicyRouter";
    string constant SYMBOL = "PRT";
    string constant STORY =
        "PolicyRouter: the immutable firewall for AI agents. Each circuit is an access and spend policy. Before every AI request the router calls eval(): allow, deny or downgrade. Anyone can re-run the check.";
    uint256 constant SUPPLY = 1_000_000;
    uint256 constant PRICE = 0.0001 ether; // OKB per transistor

    // --- permanent treasury parameters ---
    uint16 constant OPS_BPS = 5000; // 50% of mint proceeds to running costs, 50% to the grant pool
    uint256 constant MAX_GRANT = 50; // transistors per first-policy grant

    struct Circuit {
        bytes netlist;
        uint32 nIn;
        uint32 nOut;
        uint256 gates;
        uint256[] outputs;
    }

    struct Deployment {
        PolicyTreasury treasury;
        ITapeOutProcessor processor;
        ITapeOutTransistors transistors;
        uint256 circuitId;
    }

    function run() external {
        require(block.chainid == 196, "not X Layer mainnet");
        address deployer = msg.sender;
        Circuit memory c = _load("budget-guard");

        Deployment memory d = _deploy(deployer, c);
        _verify(d, c);

        console2.log("treasury        ", address(d.treasury));
        console2.log("processor       ", address(d.processor));
        console2.log("transistors     ", address(d.transistors));
        console2.log("budget-guard id ", d.circuitId);
        console2.log("deployer left   ", deployer.balance);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) _write(deployer, d);
    }

    function _load(string memory id) internal view returns (Circuit memory c) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../circuits/", id, ".json"));
        c.netlist = vm.parseJsonBytes(json, ".netlist");
        c.nIn = uint32(vm.parseJsonUint(json, ".nIn"));
        c.nOut = uint32(vm.parseJsonUint(json, ".nOut"));
        c.gates = vm.parseJsonUint(json, ".gateCount");
        c.outputs = vm.parseJsonUintArray(json, ".outputs");
    }

    function _deploy(address deployer, Circuit memory c) internal returns (Deployment memory d) {
        uint256 deployFee = FACTORY.deployFee();
        uint256 mintCost = PRICE * c.gates + FACTORY.protocolFee();
        uint256 tapeoutFee = REFERENCE_PROCESSOR.TAPEOUT_FEE();
        console2.log("deployer        ", deployer);
        console2.log("balance (wei)   ", deployer.balance);
        console2.log("fees+mint (wei) ", deployFee + mintCost + tapeoutFee);
        require(deployer.balance > deployFee + mintCost + tapeoutFee, "deployer balance too low for fees, mint and gas");

        vm.startBroadcast(deployer);
        d.treasury = new PolicyTreasury{value: deployFee}(
            FACTORY, deployer, deployer, OPS_BPS, MAX_GRANT, NAME, SYMBOL, STORY, SUPPLY, PRICE
        );
        d.transistors = d.treasury.transistors();
        d.processor = d.treasury.processor();
        require(d.processor.TAPEOUT_FEE() == tapeoutFee, "tape-out fee changed");
        d.transistors.mint{value: mintCost}(0, c.gates);
        d.circuitId = d.processor.tapeout{value: tapeoutFee}(c.netlist, c.nIn, c.nOut);
        vm.stopBroadcast();
    }

    function _verify(Deployment memory d, Circuit memory c) internal view {
        for (uint256 i = 0; i < 64; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) i < 64
            bytes memory out = d.processor.eval(d.circuitId, abi.encodePacked(uint8(i)));
            require(uint8(out[0]) == c.outputs[i], string.concat("eval mismatch at input ", vm.toString(i)));
        }
        console2.log("eval matches the truth table on all 64 inputs");
    }

    function _write(address deployer, Deployment memory d) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "factory", address(FACTORY));
        vm.serializeAddress(o, "treasury", address(d.treasury));
        vm.serializeAddress(o, "processor", address(d.processor));
        vm.serializeAddress(o, "transistors", address(d.transistors));
        vm.serializeString(o, "name", NAME);
        vm.serializeString(o, "symbol", SYMBOL);
        vm.serializeUint(o, "transistorSupply", SUPPLY);
        vm.serializeUint(o, "transistorPriceWei", PRICE);
        vm.serializeUint(o, "opsBps", OPS_BPS);
        vm.serializeUint(o, "maxGrant", MAX_GRANT);
        // Transaction hashes and blocks come from broadcast/DeployPhase1.s.sol/196/run-latest.json;
        // block.number here is the simulation block, not where the transactions landed.
        string memory out = vm.serializeUint(o, "budgetGuardCircuitId", d.circuitId);
        // DEPLOYMENT_OUT lets a local anvil rehearsal write somewhere other than the real record.
        string memory file = vm.envOr("DEPLOYMENT_OUT", string("xlayer.json"));
        vm.writeJson(out, string.concat(vm.projectRoot(), "/../deployments/", file));
    }
}
