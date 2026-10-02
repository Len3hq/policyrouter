// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ForkBase} from "./ForkBase.sol";
import {ITapeOutProcessor, ITapeOutTransistors} from "../../src/interfaces/ITapeOut.sol";
import {PolicyRegistry} from "../../src/PolicyRegistry.sol";
import {CreditEscrow} from "../../src/CreditEscrow.sol";

/// PolicyRegistry and CreditEscrow against the LIVE PolicyRouter processor on X Layer, where
/// Budget Guard is circuit 1. Also runs the router's decision end to end: read the registry and
/// escrow, build the input byte, call eval() on the real circuit.
///   forge test --match-path "test/fork/*" --fork-url https://rpc.xlayer.tech -vv
contract Phase2ForkTest is ForkBase {
    ITapeOutProcessor constant PROCESSOR = ITapeOutProcessor(0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99);
    uint256 constant BUDGET_GUARD = 1;

    PolicyRegistry reg;
    CreditEscrow escrow;
    address router = makeAddr("router");
    address payee = makeAddr("payee");
    bytes32 constant KEY = keccak256("pr-live-fork-test");
    uint128 constant CAP = 0.001 ether;
    uint256 agentId;

    function setUp() public override {
        super.setUp();
        reg = new PolicyRegistry(PROCESSOR);
        escrow = new CreditEscrow(reg, router, payee);
        vm.prank(user);
        agentId = reg.registerAgent(KEY, BUDGET_GUARD, CAP);
    }

    /// What the router does for each request (Phase 3), using only on-chain reads.
    function _decide(bytes32 keyHash, uint8 tier, uint8 size) internal view returns (bool allow, uint8 routeTier) {
        (uint256 id,, uint256 circuitId,,) = reg.policyOf(keyHash);
        uint8 input = tier | (size << 2) | (escrow.budgetOkForKey(keyHash) ? 16 : 0) | (reg.killed(keyHash) ? 32 : 0);
        if (id == 0) return (false, 0); // unknown key: fail closed before eval
        uint8 out = uint8(PROCESSOR.eval(circuitId, abi.encodePacked(input))[0]);
        return (out & 1 == 1, (out >> 1) & 3);
    }

    function _settle(uint256 cost) internal {
        CreditEscrow.Entry[] memory e = new CreditEscrow.Entry[](1);
        e[0] = CreditEscrow.Entry(agentId, cost);
        uint256 batchId = escrow.nextBatchId();
        vm.prank(router);
        escrow.settle(batchId, keccak256(abi.encode(batchId)), e);
    }

    function test_registersAgainstTheLiveBudgetGuard() public view {
        (uint256 id, address owner, uint256 circuitId, uint128 cap, bool k) = reg.policyOf(KEY);
        assertEq(id, agentId);
        assertEq(owner, user);
        assertEq(circuitId, BUDGET_GUARD);
        assertEq(cap, CAP);
        assertFalse(k);
    }

    function test_rejectsCircuitsThatDoNotExistOnTheProcessor() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnknownCircuit.selector, 999));
        reg.registerAgent(keccak256("k2"), 999, CAP);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnknownCircuit.selector, 999));
        vm.prank(user);
        reg.setCircuit(agentId, 999);
    }

    function test_rejectsCircuitsWithTheWrongShape() public {
        // tape out a 6-in / 2-out circuit on the live processor: real, but not a policy
        ITapeOutTransistors trans = ITapeOutTransistors(PROCESSOR.transistors());
        _mint(trans, user, 2);
        uint256 fee = PROCESSOR.TAPEOUT_FEE();
        vm.prank(user);
        uint256 id = PROCESSOR.tapeout{value: fee}(hex"00000002000002" hex"00000007000007", 6, 2);

        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.NotAPolicyCircuit.selector, id));
        reg.registerAgent(keccak256("k3"), id, CAP);
    }

    function test_routerDecisionFollowsChainState() public {
        // no deposit yet: budget not ok, so Budget Guard denies
        (bool allow,) = _decide(KEY, 3, 0);
        assertFalse(allow, "no balance");

        vm.prank(user);
        escrow.deposit{value: 0.01 ether}(agentId);
        uint8 tier;
        (allow, tier) = _decide(KEY, 3, 0);
        assertTrue(allow, "funded and under cap");
        assertEq(tier, 3, "Budget Guard passes the tier through");

        _settle(CAP); // spend reaches the daily cap
        (allow,) = _decide(KEY, 1, 0);
        assertFalse(allow, "cap reached");

        vm.warp(block.timestamp + 1 days);
        (allow,) = _decide(KEY, 1, 0);
        assertTrue(allow, "new day");

        vm.prank(user);
        reg.setKill(agentId, true);
        (allow,) = _decide(KEY, 0, 0);
        assertFalse(allow, "kill switch");

        (allow,) = _decide(keccak256("unknown"), 0, 0);
        assertFalse(allow, "unknown key");
    }

    function test_settleAndWithdrawMoveRealOkb() public {
        vm.prank(user);
        escrow.deposit{value: 0.01 ether}(agentId);
        _settle(0.0004 ether);
        escrow.claimEarnings();
        assertEq(payee.balance, 0.0004 ether);

        uint256 before = user.balance;
        vm.prank(user);
        escrow.withdraw(agentId, 0.0096 ether);
        assertEq(user.balance - before, 0.0096 ether);
        assertEq(address(escrow).balance, 0);
    }
}
