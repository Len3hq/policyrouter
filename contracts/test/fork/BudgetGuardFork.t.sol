// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ForkBase} from "./ForkBase.sol";
import {ITapeOutProcessor, ITapeOutTransistors} from "../../src/interfaces/ITapeOut.sol";
import {PolicyTreasury} from "../../src/PolicyTreasury.sol";

/// Tapes out circuits/budget-guard.json on a fork of the real processor contracts and checks
/// eval() against the truth table for all 64 inputs: the same check circuits/check.ts runs on mainnet.
///   forge test --match-path "test/fork/*" --fork-url https://rpc.xlayer.tech -vv
contract BudgetGuardForkTest is ForkBase {
    ITapeOutProcessor proc;
    ITapeOutTransistors trans;
    Circuit c;
    uint256 id;

    function setUp() public override {
        super.setUp();
        PolicyTreasury t = _deployTreasury();
        proc = t.processor();
        trans = t.transistors();
        c = _load("budget-guard");
        id = _tapeout(proc, deployer, c);
    }

    function test_burnsOneTransistorPerGate() public view {
        assertEq(c.gates, 8);
        assertEq(trans.balanceOf(deployer, 0), 0, "all minted transistors burned");
        assertEq(trans.minted(), c.gates);
    }

    function test_storedCircuitMatchesArtifact() public view {
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = proc.circuitInfo(id);
        assertEq(nIn, 6);
        assertEq(nOut, 3);
        assertEq(nState, 0, "combinational");
        assertEq(gates, c.gates);
        assertEq(keccak256(proc.netlist(id)), keccak256(c.netlist));
        assertEq(proc.ownerOf(id), deployer);
    }

    function test_evalMatchesTruthTableOnAll64Inputs() public view {
        assertEq(c.outputs.length, 64);
        for (uint256 i = 0; i < 64; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) i < 64
            bytes memory out = proc.eval(id, abi.encodePacked(uint8(i)));
            assertEq(out.length, 1);
            assertEq(uint8(out[0]) & 0x07, c.outputs[i], string.concat("input ", vm.toString(i)));
        }
    }

    function test_killAndBudgetDenyEverything() public view {
        for (uint256 i = 0; i < 64; i++) {
            bool kill = (i >> 5) & 1 == 1;
            bool budgetOk = (i >> 4) & 1 == 1;
            // forge-lint: disable-next-line(unsafe-typecast) i < 64
            uint8 out = uint8(proc.eval(id, abi.encodePacked(uint8(i)))[0]);
            if (kill || !budgetOk) assertEq(out, 0, "deny with route tier 0");
            else assertEq(out, 1 | ((i & 3) << 1), "allow at requested tier");
        }
    }
}
