// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ITapeOutFactory, ITapeOutProcessor, ITapeOutTransistors} from "../src/interfaces/ITapeOut.sol";

/// Phase 5 on X Layer mainnet, from the deployer:
///   1. mint the transistors for all three templates in ONE call (one protocol fee instead of three)
///   2. tape out Cheap Only, Small Requests and Strict on the PolicyRouter processor
/// Then it checks each circuit's eval() against its truth table on all 64 inputs and, when
/// broadcasting, records the circuit ids in deployments/xlayer.json.
///
/// Dry run (fork, nothing sent):
///   forge script script/DeployPhase5.s.sol --fork-url https://rpc.xlayer.tech --sender $DEPLOYER_ADDRESS
/// Broadcast (asks for the keystore password):
///   forge script script/DeployPhase5.s.sol --rpc-url https://rpc.xlayer.tech \
///     --account policyrouter-deployer --sender $DEPLOYER_ADDRESS --broadcast --slow
contract DeployPhase5 is Script {
    ITapeOutFactory constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    ITapeOutProcessor constant PROCESSOR = ITapeOutProcessor(0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99);

    struct Circuit {
        string id;
        string key; // field name in deployments/xlayer.json
        bytes netlist;
        uint32 nIn;
        uint32 nOut;
        uint256 gates;
        uint256[] outputs;
    }

    function run() external {
        require(block.chainid == 196, "not X Layer mainnet");
        address deployer = msg.sender;
        Circuit[3] memory cs = [
            _load("cheap-only", "cheapOnlyCircuitId"),
            _load("small-requests", "smallRequestsCircuitId"),
            _load("strict", "strictCircuitId")
        ];

        ITapeOutTransistors transistors = ITapeOutTransistors(PROCESSOR.transistors());
        uint256 gates = cs[0].gates + cs[1].gates + cs[2].gates;
        uint256 mintCost = transistors.mintPrice() * gates + FACTORY.protocolFee();
        uint256 tapeoutFee = PROCESSOR.TAPEOUT_FEE();
        uint256 total = mintCost + 3 * tapeoutFee;
        console2.log("deployer        ", deployer);
        console2.log("balance (wei)   ", deployer.balance);
        console2.log("transistors     ", gates);
        console2.log("fees+mint (wei) ", total);
        require(deployer.balance > total, "deployer balance too low for mint, fees and gas");

        uint256[3] memory ids;
        vm.startBroadcast(deployer);
        transistors.mint{value: mintCost}(0, gates);
        for (uint256 i = 0; i < 3; i++) {
            ids[i] = PROCESSOR.tapeout{value: tapeoutFee}(cs[i].netlist, cs[i].nIn, cs[i].nOut);
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < 3; i++) {
            _verify(cs[i], ids[i]);
            console2.log(string.concat(cs[i].id, " circuit id"), ids[i]);
        }
        console2.log("deployer left   ", deployer.balance);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory file =
                string.concat(vm.projectRoot(), "/../deployments/", vm.envOr("DEPLOYMENT_OUT", string("xlayer.json")));
            for (uint256 i = 0; i < 3; i++) {
                vm.writeJson(vm.toString(ids[i]), file, string.concat(".", cs[i].key));
            }
        }
    }

    function _load(string memory id, string memory key) internal view returns (Circuit memory c) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../circuits/", id, ".json"));
        c.id = id;
        c.key = key;
        c.netlist = vm.parseJsonBytes(json, ".netlist");
        c.nIn = uint32(vm.parseJsonUint(json, ".nIn"));
        c.nOut = uint32(vm.parseJsonUint(json, ".nOut"));
        c.gates = vm.parseJsonUint(json, ".gateCount");
        c.outputs = vm.parseJsonUintArray(json, ".outputs");
    }

    function _verify(Circuit memory c, uint256 circuitId) internal view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = PROCESSOR.circuitInfo(circuitId);
        require(nIn == 6 && nOut == 3 && nState == 0 && gates == c.gates, string.concat(c.id, ": shape"));
        for (uint256 i = 0; i < 64; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) i < 64
            bytes memory out = PROCESSOR.eval(circuitId, abi.encodePacked(uint8(i)));
            require(uint8(out[0]) == c.outputs[i], string.concat(c.id, ": eval mismatch at input ", vm.toString(i)));
        }
    }
}
