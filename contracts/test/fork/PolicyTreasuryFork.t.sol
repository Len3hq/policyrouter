// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ForkBase} from "./ForkBase.sol";
import {ITapeOutProcessor, ITapeOutTransistors} from "../../src/interfaces/ITapeOut.sol";
import {PolicyTreasury} from "../../src/PolicyTreasury.sol";

contract PolicyTreasuryForkTest is ForkBase {
    PolicyTreasury t;
    ITapeOutTransistors trans;

    function setUp() public override {
        super.setUp();
        t = _deployTreasury();
        trans = t.transistors();
    }

    function _assertSolvent() internal view {
        assertGe(address(t).balance, t.pool() + t.opsOwed(), "treasury holds what it owes");
    }

    // --- creation ---

    function test_treasuryIsCreatorOfARealProcessor() public view {
        assertTrue(FACTORY.isCPU(address(t.processor())));
        assertEq(trans.creator(), address(t));
        assertEq(trans.circuits(), address(t.processor()));
        assertEq(trans.supplyCap(), SUPPLY);
        assertEq(trans.mintPrice(), PRICE);
        assertEq(t.ops(), ops);
        assertEq(t.granter(), granter);
        assertEq(t.opsBps(), OPS_BPS);
        assertEq(t.maxGrant(), MAX_GRANT);
    }

    function test_constructorRejectsBadParams() public {
        uint256 fee = FACTORY.deployFee();
        vm.expectRevert(PolicyTreasury.BadBps.selector);
        new PolicyTreasury{value: fee}(FACTORY, ops, granter, 10_001, MAX_GRANT, "P", "P", "", SUPPLY, PRICE);
        vm.expectRevert(PolicyTreasury.ZeroAddress.selector);
        new PolicyTreasury{value: fee}(FACTORY, address(0), granter, OPS_BPS, MAX_GRANT, "P", "P", "", SUPPLY, PRICE);
        vm.expectRevert(PolicyTreasury.ZeroAddress.selector);
        new PolicyTreasury{value: fee}(FACTORY, ops, address(0), OPS_BPS, MAX_GRANT, "P", "P", "", SUPPLY, PRICE);
    }

    // --- sweep and split ---

    function test_sweepSplitsMintProceeds() public {
        _mint(trans, user, 100);
        uint256 proceeds = PRICE * 100;
        assertEq(trans.owed(address(t)), proceeds, "treasury owed the full mint price");

        t.sweep();
        assertEq(t.opsOwed(), proceeds * OPS_BPS / 10_000);
        assertEq(t.pool(), proceeds - t.opsOwed());
        assertEq(trans.owed(address(t)), 0);
        _assertSolvent();
    }

    function test_sweepWithNothingOwedReverts() public {
        vm.expectRevert(PolicyTreasury.NothingToSweep.selector);
        t.sweep();
    }

    function test_withdrawOpsPaysOnlyOps() public {
        _mint(trans, user, 100);
        t.sweep();
        uint256 owed = t.opsOwed();
        vm.prank(user); // anyone can trigger it; the money still goes to ops
        t.withdrawOps();
        assertEq(ops.balance, owed);
        assertEq(t.opsOwed(), 0);
        _assertSolvent();
    }

    function testFuzz_splitNeverLosesOrCreatesMoney(uint16 amount) public {
        vm.assume(amount > 0 && amount <= 5000);
        _mint(trans, user, amount);
        t.sweep();
        assertEq(t.pool() + t.opsOwed(), PRICE * amount);
        _assertSolvent();
    }

    // --- grants ---

    function _fundPool() internal {
        _mint(trans, user, 2000); // 0.2 OKB of proceeds, 0.1 to the pool
        t.sweep();
    }

    function test_grantGivesTransistorsFromThePool() public {
        _fundPool();
        uint256 poolBefore = t.pool();
        address newOwner = makeAddr("newOwner");
        uint256 cost = PRICE * 30 + FACTORY.protocolFee();

        vm.prank(granter);
        t.grant(newOwner, 30);

        assertEq(trans.balanceOf(newOwner, 0), 30);
        assertEq(t.pool(), poolBefore - cost);
        assertTrue(t.granted(newOwner));
        assertEq(t.selfMintPending(), PRICE * 30);
        _assertSolvent();
    }

    function test_selfMintReturnsToPoolOnSweep() public {
        _fundPool();
        uint256 poolBefore = t.pool();
        uint256 opsBefore = t.opsOwed();
        vm.prank(granter);
        t.grant(makeAddr("newOwner"), 30);

        t.sweep(); // only the grant's own mint price is owed
        assertEq(t.selfMintPending(), 0);
        assertEq(t.opsOwed(), opsBefore, "ops is not paid twice on granted transistors");
        assertEq(t.pool(), poolBefore - FACTORY.protocolFee(), "a grant costs the pool only the protocol fee");
        _assertSolvent();
    }

    function test_grantRules() public {
        _fundPool();
        address a = makeAddr("a");

        vm.expectRevert(PolicyTreasury.NotGranter.selector);
        vm.prank(user);
        t.grant(a, 10);

        vm.startPrank(granter);
        vm.expectRevert(PolicyTreasury.BadGrantAmount.selector);
        t.grant(a, 0);
        vm.expectRevert(PolicyTreasury.BadGrantAmount.selector);
        t.grant(a, MAX_GRANT + 1);
        vm.expectRevert(PolicyTreasury.ZeroAddress.selector);
        t.grant(address(0), 10);

        t.grant(a, 10);
        vm.expectRevert(PolicyTreasury.AlreadyGranted.selector);
        t.grant(a, 10);
        vm.stopPrank();
    }

    function test_grantFailsWhenPoolIsTooSmall() public {
        vm.expectRevert(PolicyTreasury.PoolTooSmall.selector);
        vm.prank(granter);
        t.grant(makeAddr("a"), 10);
    }

    function test_grantedTransistorsCanTapeOut() public {
        _fundPool();
        Circuit memory c = _load("budget-guard");
        address newOwner = makeAddr("newOwner");
        vm.deal(newOwner, 1 ether);
        vm.prank(granter);
        t.grant(newOwner, c.gates);
        ITapeOutProcessor proc = t.processor();
        uint256 fee = proc.TAPEOUT_FEE();
        vm.prank(newOwner);
        uint256 id = proc.tapeout{value: fee}(c.netlist, c.nIn, c.nOut);
        assertEq(proc.ownerOf(id), newOwner);
        assertEq(trans.balanceOf(newOwner, 0), 0, "granted transistors burned by the tape-out");
    }

    // --- receive ---

    function test_rejectsPlainTransfers() public {
        vm.prank(user);
        (bool ok,) = address(t).call{value: 1 ether}("");
        assertFalse(ok);
    }
}
