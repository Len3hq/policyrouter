// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ITapeOutProcessor} from "../src/interfaces/ITapeOut.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {CreditEscrow} from "../src/CreditEscrow.sol";
import {MockProcessor} from "./mocks/MockProcessor.sol";

/// An agent owner whose receive() tries to withdraw again.
contract ReentrantOwner {
    CreditEscrow public escrow;
    uint256 public agentId;
    uint256 public reentries;

    constructor(CreditEscrow escrow_, PolicyRegistry reg) {
        escrow = escrow_;
        agentId = reg.registerAgent(keccak256("attacker-key"), 1, 1 ether);
    }

    function fund() external payable {
        escrow.deposit{value: msg.value}(agentId);
    }

    function attack(uint256 amount) external {
        escrow.withdraw(agentId, amount);
    }

    receive() external payable {
        reentries++;
        escrow.withdraw(agentId, msg.value); // must fail: nonReentrant
    }
}

contract CreditEscrowTest is Test {
    MockProcessor proc;
    PolicyRegistry reg;
    CreditEscrow escrow;

    address router = makeAddr("router");
    address payee = makeAddr("payee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint128 constant CAP = 1 ether;
    uint256 aliceId;
    uint256 bobId;

    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event Debited(uint256 indexed batchId, uint256 indexed agentId, uint256 amount);
    event Shortfall(uint256 indexed batchId, uint256 indexed agentId, uint256 amount);
    event Settled(uint256 indexed batchId, bytes32 root, uint256 entries, uint256 debited);

    function setUp() public {
        vm.warp(1_790_000_000); // a realistic timestamp, mid-day UTC
        proc = new MockProcessor();
        proc.set(1, 6, 3, 0, 8);
        reg = new PolicyRegistry(ITapeOutProcessor(address(proc)));
        escrow = new CreditEscrow(reg, router, payee);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.prank(alice);
        aliceId = reg.registerAgent(keccak256("alice"), 1, CAP);
        vm.prank(bob);
        bobId = reg.registerAgent(keccak256("bob"), 1, CAP);
    }

    function _deposit(address who, uint256 id, uint256 amount) internal {
        vm.prank(who);
        escrow.deposit{value: amount}(id);
    }

    function _entries1(uint256 id, uint256 cost) internal pure returns (CreditEscrow.Entry[] memory e) {
        e = new CreditEscrow.Entry[](1);
        e[0] = CreditEscrow.Entry(id, cost);
    }

    function _settle(CreditEscrow.Entry[] memory e) internal {
        uint256 id = escrow.nextBatchId();
        vm.prank(router);
        escrow.settle(id, keccak256(abi.encode("root", id)), e);
    }

    function _assertSolvent() internal view {
        assertGe(address(escrow).balance, escrow.totalBalances() + escrow.earned(), "escrow holds what it owes");
    }

    // --- constructor ---

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(CreditEscrow.ZeroAddress.selector);
        new CreditEscrow(reg, address(0), payee);
        vm.expectRevert(CreditEscrow.ZeroAddress.selector);
        new CreditEscrow(reg, router, address(0));
    }

    // --- deposit ---

    function test_depositRaisesBalanceAndEmits() public {
        vm.expectEmit(address(escrow));
        emit Deposited(aliceId, alice, 2 ether);
        _deposit(alice, aliceId, 2 ether);
        assertEq(escrow.balanceOf(aliceId), 2 ether);
        assertEq(escrow.totalBalances(), 2 ether);
        _assertSolvent();
    }

    function test_onlyOwnerCanDeposit() public {
        vm.expectRevert(CreditEscrow.NotAgentOwner.selector);
        _deposit(bob, aliceId, 1 ether);
        vm.expectRevert(CreditEscrow.NotAgentOwner.selector);
        _deposit(alice, 99, 1 ether); // unknown agent
    }

    function test_depositRejectsZero() public {
        vm.expectRevert(CreditEscrow.ZeroAmount.selector);
        _deposit(alice, aliceId, 0);
    }

    function test_depositFollowsAgentTransfer() public {
        vm.prank(alice);
        reg.transferAgent(aliceId, bob);
        vm.expectRevert(CreditEscrow.NotAgentOwner.selector);
        _deposit(alice, aliceId, 1 ether);
        _deposit(bob, aliceId, 1 ether);
    }

    // --- withdraw ---

    function test_ownerWithdrawsUnusedBalance() public {
        _deposit(alice, aliceId, 2 ether);
        uint256 before = alice.balance;
        vm.expectEmit(address(escrow));
        emit Withdrawn(aliceId, alice, 0.5 ether);
        vm.prank(alice);
        escrow.withdraw(aliceId, 0.5 ether);
        assertEq(alice.balance - before, 0.5 ether);
        assertEq(escrow.balanceOf(aliceId), 1.5 ether);
        assertEq(escrow.totalBalances(), 1.5 ether);
        _assertSolvent();
    }

    function test_withdrawRules() public {
        _deposit(alice, aliceId, 1 ether);
        vm.expectRevert(CreditEscrow.NotAgentOwner.selector);
        vm.prank(bob);
        escrow.withdraw(aliceId, 1);

        vm.startPrank(alice);
        vm.expectRevert(CreditEscrow.InsufficientBalance.selector);
        escrow.withdraw(aliceId, 1 ether + 1);
        vm.expectRevert(CreditEscrow.ZeroAmount.selector);
        escrow.withdraw(aliceId, 0);
        vm.stopPrank();
    }

    function test_withdrawWorksWhileKilled() public {
        _deposit(alice, aliceId, 1 ether);
        vm.startPrank(alice);
        reg.setKill(aliceId, true);
        escrow.withdraw(aliceId, 1 ether);
        vm.stopPrank();
        assertEq(escrow.balanceOf(aliceId), 0);
    }

    function test_reentrantWithdrawCannotDrain() public {
        _deposit(alice, aliceId, 5 ether); // other people's money in the contract
        ReentrantOwner attacker = new ReentrantOwner(escrow, reg);
        attacker.fund{value: 1 ether}();

        vm.expectRevert(CreditEscrow.TransferFailed.selector);
        attacker.attack(1 ether);

        assertEq(escrow.balanceOf(attacker.agentId()), 1 ether, "attack rolled back");
        assertEq(address(escrow).balance, 6 ether);
        _assertSolvent();
    }

    // --- settle ---

    function test_onlyRouterCanSettle() public {
        vm.expectRevert(CreditEscrow.NotRouter.selector);
        vm.prank(alice);
        escrow.settle(0, bytes32(0), _entries1(aliceId, 1));
    }

    function test_settleDebitsAndStoresRoot() public {
        _deposit(alice, aliceId, 0.5 ether);
        _deposit(bob, bobId, 0.5 ether);
        CreditEscrow.Entry[] memory e = new CreditEscrow.Entry[](2);
        e[0] = CreditEscrow.Entry(aliceId, 0.1 ether);
        e[1] = CreditEscrow.Entry(bobId, 0.2 ether);
        bytes32 root = keccak256("batch-0");

        vm.roll(1234);
        vm.expectEmit(address(escrow));
        emit Debited(0, aliceId, 0.1 ether);
        vm.expectEmit(address(escrow));
        emit Debited(0, bobId, 0.2 ether);
        vm.expectEmit(address(escrow));
        emit Settled(0, root, 2, 0.3 ether);
        vm.prank(router);
        escrow.settle(0, root, e);

        assertEq(escrow.balanceOf(aliceId), 0.4 ether);
        assertEq(escrow.balanceOf(bobId), 0.3 ether);
        assertEq(escrow.spentToday(aliceId), 0.1 ether);
        assertEq(escrow.totalBalances(), 0.7 ether);
        assertEq(escrow.earned(), 0.3 ether);
        (bytes32 r, uint64 b) = escrow.batch(0);
        assertEq(r, root);
        assertEq(b, 1234);
        assertEq(escrow.nextBatchId(), 1);
        _assertSolvent();
    }

    function test_batchIdsMustBeInOrderAndUnique() public {
        vm.startPrank(router);
        vm.expectRevert(abi.encodeWithSelector(CreditEscrow.WrongBatchId.selector, 0));
        escrow.settle(1, bytes32(0), new CreditEscrow.Entry[](0));
        escrow.settle(0, bytes32(0), new CreditEscrow.Entry[](0));
        vm.expectRevert(abi.encodeWithSelector(CreditEscrow.WrongBatchId.selector, 1));
        escrow.settle(0, bytes32(0), new CreditEscrow.Entry[](0));
        vm.stopPrank();
    }

    function test_settleNeverDebitsMoreThanBalance() public {
        _deposit(alice, aliceId, 0.1 ether);
        vm.expectEmit(address(escrow));
        emit Debited(0, aliceId, 0.1 ether);
        vm.expectEmit(address(escrow));
        emit Shortfall(0, aliceId, 0.2 ether);
        _settle(_entries1(aliceId, 0.3 ether));
        assertEq(escrow.balanceOf(aliceId), 0);
        assertEq(escrow.earned(), 0.1 ether);
        _assertSolvent();
    }

    function test_settleNeverPushesSpendPastCap() public {
        _deposit(alice, aliceId, 5 ether);
        _settle(_entries1(aliceId, 0.8 ether));
        vm.expectEmit(address(escrow));
        emit Debited(1, aliceId, 0.2 ether);
        vm.expectEmit(address(escrow));
        emit Shortfall(1, aliceId, 0.3 ether);
        _settle(_entries1(aliceId, 0.5 ether));
        assertEq(escrow.spentToday(aliceId), CAP);
        assertEq(escrow.balanceOf(aliceId), 4 ether);
    }

    function test_settleAfterCapIsLoweredBelowSpendDebitsNothing() public {
        _deposit(alice, aliceId, 5 ether);
        _settle(_entries1(aliceId, 0.5 ether));
        vm.prank(alice);
        reg.setDailyCap(aliceId, 0.2 ether);
        assertFalse(escrow.budgetOk(aliceId));
        vm.expectEmit(address(escrow));
        emit Shortfall(1, aliceId, 0.1 ether);
        _settle(_entries1(aliceId, 0.1 ether));
        assertEq(escrow.spentToday(aliceId), 0.5 ether);
    }

    function test_oneBadEntryDoesNotBlockTheBatch() public {
        _deposit(bob, bobId, 1 ether);
        CreditEscrow.Entry[] memory e = new CreditEscrow.Entry[](3);
        e[0] = CreditEscrow.Entry(aliceId, 0.1 ether); // no balance
        e[1] = CreditEscrow.Entry(99, 0.1 ether); // unknown agent
        e[2] = CreditEscrow.Entry(bobId, 0.1 ether);
        _settle(e);
        assertEq(escrow.balanceOf(bobId), 0.9 ether);
        assertEq(escrow.earned(), 0.1 ether);
        _assertSolvent();
    }

    function test_settleDebitsKilledAgentsForWorkAlreadyDone() public {
        _deposit(alice, aliceId, 1 ether);
        vm.prank(alice);
        reg.setKill(aliceId, true);
        _settle(_entries1(aliceId, 0.1 ether));
        assertEq(escrow.balanceOf(aliceId), 0.9 ether);
    }

    // --- budget ---

    function test_budgetOkFlipsAtCapAndResetsNextDay() public {
        _deposit(alice, aliceId, 5 ether);
        assertTrue(escrow.budgetOk(aliceId));
        _settle(_entries1(aliceId, CAP - 1));
        assertTrue(escrow.budgetOk(aliceId), "1 wei of room left");
        _settle(_entries1(aliceId, 1));
        assertFalse(escrow.budgetOk(aliceId), "at the cap");
        assertFalse(escrow.budgetOkForKey(keccak256("alice")));

        vm.warp(block.timestamp + 1 days);
        assertEq(escrow.spentToday(aliceId), 0);
        assertTrue(escrow.budgetOk(aliceId), "new UTC day");
        _settle(_entries1(aliceId, 0.3 ether));
        assertEq(escrow.spentToday(aliceId), 0.3 ether);
    }

    function test_budgetNotOkWithoutBalance() public view {
        assertFalse(escrow.budgetOk(aliceId));
    }

    function test_budgetOkForKey() public {
        _deposit(alice, aliceId, 1 ether);
        assertTrue(escrow.budgetOkForKey(keccak256("alice")));
        assertFalse(escrow.budgetOkForKey(keccak256("unknown")), "unknown key fails closed");
    }

    // --- earnings ---

    function test_claimEarningsPaysOnlyPayee() public {
        _deposit(alice, aliceId, 1 ether);
        _settle(_entries1(aliceId, 0.25 ether));
        vm.prank(bob); // anyone can trigger it
        escrow.claimEarnings();
        assertEq(payee.balance, 0.25 ether);
        assertEq(escrow.earned(), 0);
        _assertSolvent();
    }

    // --- isInBatch edge cases (full vectors in MerkleCompat.t.sol) ---

    function test_isInBatchIsFalseForUnsettledBatch() public view {
        assertFalse(escrow.isInBatch(0, bytes32(uint256(1)), new bytes32[](0)));
    }

    // --- fuzz ---

    /// Random deposits, settles and withdraws never leave the escrow owing more than it holds.
    function testFuzz_neverInsolvent(uint96[6] calldata amounts, uint8 ops) public {
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amt = bound(amounts[i], 1, 3 ether);
            uint256 id = i % 2 == 0 ? aliceId : bobId;
            address who = i % 2 == 0 ? alice : bob;
            uint8 op = (ops >> (i % 8)) & 3;
            if (op == 0 || escrow.balanceOf(id) == 0) {
                _deposit(who, id, amt);
            } else if (op == 1) {
                _settle(_entries1(id, amt));
            } else if (op == 2) {
                uint256 w = amt > escrow.balanceOf(id) ? escrow.balanceOf(id) : amt;
                vm.prank(who);
                escrow.withdraw(id, w);
            } else {
                vm.warp(block.timestamp + 1 days);
            }
            _assertSolvent();
            assertEq(escrow.totalBalances(), escrow.balanceOf(aliceId) + escrow.balanceOf(bobId));
            assertLe(escrow.spentToday(id), CAP);
        }
    }
}
