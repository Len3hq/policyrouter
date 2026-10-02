// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ITapeOutProcessor} from "../src/interfaces/ITapeOut.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {CreditEscrow} from "../src/CreditEscrow.sol";
import {MockProcessor} from "./mocks/MockProcessor.sol";

/// Drives the escrow with random owner and router actions for the invariant test.
contract EscrowHandler is Test {
    PolicyRegistry public reg;
    CreditEscrow public escrow;
    address public router;
    address[3] public owners;
    uint256[3] public ids;

    /// Set if a settle ever raises an agent's spend for the day above its cap.
    bool public capBreached;
    uint256 public settles;

    constructor(PolicyRegistry reg_, CreditEscrow escrow_, address router_) {
        reg = reg_;
        escrow = escrow_;
        router = router_;
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = makeAddr(string.concat("owner", vm.toString(i)));
            vm.deal(owners[i], 1_000 ether);
            vm.prank(owners[i]);
            ids[i] = reg.registerAgent(keccak256(abi.encode("key", i)), 1, uint128(1 ether * (i + 1)));
        }
    }

    function deposit(uint256 who, uint256 amount) external {
        who = bound(who, 0, 2);
        amount = bound(amount, 1, 5 ether);
        vm.prank(owners[who]);
        escrow.deposit{value: amount}(ids[who]);
    }

    function withdraw(uint256 who, uint256 amount) external {
        who = bound(who, 0, 2);
        uint256 bal = escrow.balanceOf(ids[who]);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(owners[who]);
        escrow.withdraw(ids[who], amount);
    }

    function settle(uint256 seed, uint256 n) external {
        n = bound(n, 0, 5);
        CreditEscrow.Entry[] memory e = new CreditEscrow.Entry[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 k = uint256(keccak256(abi.encode(seed, i)));
            e[i] = CreditEscrow.Entry(ids[k % 3], bound(k >> 8, 0, 2 ether));
        }
        uint256[3] memory before;
        for (uint256 i = 0; i < 3; i++) {
            before[i] = escrow.spentToday(ids[i]);
        }
        uint256 batchId = escrow.nextBatchId();
        vm.prank(router);
        escrow.settle(batchId, bytes32(seed), e);
        settles++;
        for (uint256 i = 0; i < 3; i++) {
            uint256 spent = escrow.spentToday(ids[i]);
            if (spent > before[i] && spent > reg.dailyCapOf(ids[i])) capBreached = true;
        }
    }

    function setCap(uint256 who, uint128 cap) external {
        who = bound(who, 0, 2);
        cap = uint128(bound(cap, 0, 10 ether));
        vm.prank(owners[who]);
        reg.setDailyCap(ids[who], cap);
    }

    function nextDay() external {
        vm.warp(block.timestamp + 1 days);
    }

    function claim() external {
        escrow.claimEarnings();
    }
}

contract CreditEscrowInvariantTest is Test {
    CreditEscrow escrow;
    EscrowHandler handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        MockProcessor proc = new MockProcessor();
        proc.set(1, 6, 3, 0, 8);
        PolicyRegistry reg = new PolicyRegistry(ITapeOutProcessor(address(proc)));
        address router = makeAddr("router");
        escrow = new CreditEscrow(reg, router, makeAddr("payee"));
        handler = new EscrowHandler(reg, escrow, router);
        targetContract(address(handler));
    }

    function invariant_solvent() public view {
        assertGe(address(escrow).balance, escrow.totalBalances() + escrow.earned());
    }

    function invariant_totalBalancesIsTheSumOfBalances() public view {
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            sum += escrow.balanceOf(handler.ids(i));
        }
        assertEq(escrow.totalBalances(), sum);
    }

    function invariant_settleNeverRaisesSpendAboveCap() public view {
        assertFalse(handler.capBreached());
    }
}
