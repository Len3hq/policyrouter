// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ITapeOutProcessor} from "../src/interfaces/ITapeOut.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {CreditEscrow} from "../src/CreditEscrow.sol";
import {MockProcessor} from "./mocks/MockProcessor.sol";

/// Trees built in TypeScript with the OpenZeppelin merkle-tree library (packages/policy/test/vectors.json)
/// must verify on chain through CreditEscrow.isInBatch, so the settler and the contract agree.
contract MerkleCompatTest is Test {
    CreditEscrow escrow;
    address router = makeAddr("router");
    string json;
    uint256 constant CASES = 5;

    function setUp() public {
        MockProcessor proc = new MockProcessor();
        PolicyRegistry reg = new PolicyRegistry(ITapeOutProcessor(address(proc)));
        escrow = new CreditEscrow(reg, router, makeAddr("payee"));
        json = vm.readFile(string.concat(vm.projectRoot(), "/../packages/policy/test/vectors.json"));

        // settle one batch per vector case: batch i has case i's root
        vm.startPrank(router);
        for (uint256 i = 0; i < CASES; i++) {
            escrow.settle(i, vm.parseJsonBytes32(json, _key(i, ".root")), new CreditEscrow.Entry[](0));
        }
        vm.stopPrank();
    }

    function _key(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".cases[", vm.toString(i), "]", field);
    }

    function _proof(uint256 i, uint256 j) internal view returns (bytes32[] memory) {
        string memory k = _key(i, string.concat(".proofs[", vm.toString(j), "]"));
        // a one-leaf tree has an empty proof, which the JSON parser cannot type
        if (vm.parseJsonUint(json, _key(i, ".size")) == 1) return new bytes32[](0);
        return vm.parseJsonBytes32Array(json, k);
    }

    function test_everyTypeScriptProofVerifiesOnChain() public view {
        uint256 checked;
        for (uint256 i = 0; i < CASES; i++) {
            bytes32[] memory leaves = vm.parseJsonBytes32Array(json, _key(i, ".leaves"));
            for (uint256 j = 0; j < leaves.length; j++) {
                assertTrue(escrow.isInBatch(i, leaves[j], _proof(i, j)), "proof must verify");
                checked++;
            }
        }
        assertEq(checked, 1 + 2 + 3 + 7 + 16);
    }

    function test_proofsFailAgainstTheWrongBatch() public view {
        // case 2 (3 leaves) checked against batch 3 (7 leaves)
        bytes32[] memory leaves = vm.parseJsonBytes32Array(json, _key(2, ".leaves"));
        assertFalse(escrow.isInBatch(3, leaves[0], _proof(2, 0)));
    }

    function test_tamperedLeafOrProofFails() public view {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(json, _key(3, ".leaves"));
        bytes32[] memory proof = _proof(3, 0);
        assertFalse(escrow.isInBatch(3, bytes32(uint256(leaves[0]) ^ 1), proof), "changed leaf");
        proof[0] = bytes32(uint256(proof[0]) ^ 1);
        assertFalse(escrow.isInBatch(3, leaves[0], proof), "changed proof");
    }

    function test_unsettledBatchIsFalse() public view {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(json, _key(0, ".leaves"));
        assertFalse(escrow.isInBatch(CASES, leaves[0], new bytes32[](0)));
    }
}
