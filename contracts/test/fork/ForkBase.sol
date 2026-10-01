// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ITapeOutFactory, ITapeOutProcessor, ITapeOutTransistors} from "../../src/interfaces/ITapeOut.sol";
import {PolicyTreasury} from "../../src/PolicyTreasury.sol";

/// Shared setup for tests against the live TapeOut contracts on an X Layer fork.
/// Skipped automatically when not forking X Layer (chain 196).
abstract contract ForkBase is Test {
    ITapeOutFactory constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);

    uint256 constant SUPPLY = 1_000_000;
    uint256 constant PRICE = 0.0001 ether;
    uint16 constant OPS_BPS = 5000;
    uint256 constant MAX_GRANT = 50;

    struct Circuit {
        bytes netlist;
        uint32 nIn;
        uint32 nOut;
        uint32 gates;
        uint256[] outputs;
    }

    address deployer = makeAddr("deployer");
    address ops = makeAddr("ops");
    address granter = makeAddr("granter");
    address user = makeAddr("user");

    function setUp() public virtual {
        vm.skip(block.chainid != 196);
        vm.deal(deployer, 10 ether);
        vm.deal(user, 10 ether);
    }

    function _deployTreasury() internal returns (PolicyTreasury t) {
        uint256 fee = FACTORY.deployFee();
        vm.prank(deployer);
        t = new PolicyTreasury{value: fee}(
            FACTORY, ops, granter, OPS_BPS, MAX_GRANT, "PolicyRouter", "PRT", "test", SUPPLY, PRICE
        );
    }

    function _load(string memory id) internal view returns (Circuit memory c) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../circuits/", id, ".json"));
        c.netlist = vm.parseJsonBytes(json, ".netlist");
        c.nIn = uint32(vm.parseJsonUint(json, ".nIn"));
        c.nOut = uint32(vm.parseJsonUint(json, ".nOut"));
        c.gates = uint32(vm.parseJsonUint(json, ".gateCount"));
        c.outputs = vm.parseJsonUintArray(json, ".outputs");
    }

    function _mint(ITapeOutTransistors trans, address who, uint256 amount) internal {
        uint256 cost = trans.mintPrice() * amount + FACTORY.protocolFee();
        vm.prank(who);
        trans.mint{value: cost}(0, amount);
    }

    function _tapeout(ITapeOutProcessor proc, address who, Circuit memory c) internal returns (uint256 id) {
        _mint(ITapeOutTransistors(proc.transistors()), who, c.gates);
        uint256 fee = proc.TAPEOUT_FEE();
        vm.prank(who);
        id = proc.tapeout{value: fee}(c.netlist, c.nIn, c.nOut);
    }
}
