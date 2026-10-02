// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ForkBase} from "./ForkBase.sol";
import {ITapeOutProcessor, ITapeOutTransistors} from "../../src/interfaces/ITapeOut.sol";

/// Tapes out the three Phase 5 templates on the LIVE PolicyRouter processor (fork only) and checks
/// eval() against each truth table on all 64 inputs: the same check circuits/check.ts runs on mainnet.
contract TemplatesForkTest is ForkBase {
    ITapeOutProcessor constant PROCESSOR = ITapeOutProcessor(0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99);

    function _checkTemplate(string memory id, uint32 expectedGates) internal {
        Circuit memory c = _load(id);
        assertEq(c.gates, expectedGates, "gate count");
        ITapeOutTransistors trans = ITapeOutTransistors(PROCESSOR.transistors());
        uint256 burnedBefore = trans.balanceOf(user, 0);
        uint256 circuitId = _tapeout(PROCESSOR, user, c);
        assertEq(trans.balanceOf(user, 0), burnedBefore, "minted exactly the gates and burned them all");

        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = PROCESSOR.circuitInfo(circuitId);
        assertEq(nIn, 6);
        assertEq(nOut, 3);
        assertEq(nState, 0);
        assertEq(gates, c.gates);
        assertEq(keccak256(PROCESSOR.netlist(circuitId)), keccak256(c.netlist));
        for (uint256 i = 0; i < 64; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) i < 64
            bytes memory out = PROCESSOR.eval(circuitId, abi.encodePacked(uint8(i)));
            assertEq(uint8(out[0]) & 0x07, c.outputs[i], string.concat(id, " input ", vm.toString(i)));
        }
    }

    function test_cheapOnly() public {
        _checkTemplate("cheap-only", 10);
    }

    function test_smallRequests() public {
        _checkTemplate("small-requests", 11);
    }

    function test_strict() public {
        _checkTemplate("strict", 13);
    }
}
