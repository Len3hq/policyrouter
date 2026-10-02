// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ITapeOutProcessor} from "../src/interfaces/ITapeOut.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {MockProcessor} from "./mocks/MockProcessor.sol";

contract PolicyRegistryTest is Test {
    MockProcessor proc;
    PolicyRegistry reg;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant KEY = keccak256("pr-live-alice");
    bytes32 constant KEY2 = keccak256("pr-live-alice-2");
    uint128 constant CAP = 0.01 ether;

    event AgentRegistered(
        uint256 indexed agentId, address indexed owner, bytes32 indexed keyHash, uint256 circuitId, uint128 dailyCap
    );
    event CircuitChanged(uint256 indexed agentId, uint256 oldCircuitId, uint256 newCircuitId);
    event DailyCapChanged(uint256 indexed agentId, uint128 oldCap, uint128 newCap);
    event KillSet(uint256 indexed agentId, bool killed);
    event KeyRotated(uint256 indexed agentId, bytes32 indexed oldKeyHash, bytes32 indexed newKeyHash);
    event OwnerChanged(uint256 indexed agentId, address indexed oldOwner, address indexed newOwner);

    function setUp() public {
        proc = new MockProcessor();
        proc.set(1, 6, 3, 0, 8); // Budget Guard shape
        proc.set(2, 6, 3, 0, 20); // another policy
        proc.set(3, 6, 2, 0, 2); // wrong output count
        proc.set(4, 6, 3, 1, 9); // has state
        proc.set(5, 5, 3, 0, 9); // wrong input count
        proc.set(6, 6, 3, 0, 0); // no gates
        reg = new PolicyRegistry(ITapeOutProcessor(address(proc)));
    }

    function _register() internal returns (uint256 id) {
        vm.prank(alice);
        id = reg.registerAgent(KEY, 1, CAP);
    }

    // --- registerAgent ---

    function test_registerStoresAgentAndEmits() public {
        vm.expectEmit(address(reg));
        emit AgentRegistered(1, alice, KEY, 1, CAP);
        uint256 id = _register();

        assertEq(id, 1);
        assertEq(reg.agentCount(), 1);
        assertEq(reg.agentOf(KEY), 1);
        assertTrue(reg.keyUsed(KEY));
        PolicyRegistry.Agent memory a = reg.agent(id);
        assertEq(a.owner, alice);
        assertEq(a.circuitId, 1);
        assertEq(a.dailyCap, CAP);
        assertFalse(a.killed);
        assertEq(a.keyHash, KEY);
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.dailyCapOf(id), CAP);
    }

    function test_agentIdsAreSequential() public {
        _register();
        vm.prank(bob);
        assertEq(reg.registerAgent(KEY2, 2, CAP), 2);
    }

    function test_registerRevertsForUsedKey() public {
        _register();
        vm.expectRevert(PolicyRegistry.KeyAlreadyUsed.selector);
        vm.prank(bob);
        reg.registerAgent(KEY, 1, CAP);
    }

    function test_registerRevertsForZeroKey() public {
        vm.expectRevert(PolicyRegistry.ZeroKeyHash.selector);
        reg.registerAgent(bytes32(0), 1, CAP);
    }

    function test_registerRevertsForUnknownCircuit() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnknownCircuit.selector, 99));
        reg.registerAgent(KEY, 99, CAP);
        uint256 huge = uint256(type(uint64).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnknownCircuit.selector, huge));
        reg.registerAgent(KEY, huge, CAP);
    }

    function test_registerRevertsForCircuitsWithoutPolicyShape() public {
        for (uint256 id = 3; id <= 6; id++) {
            vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.NotAPolicyCircuit.selector, id));
            reg.registerAgent(KEY, id, CAP);
        }
    }

    function test_failedRegistrationDoesNotBurnTheKey() public {
        vm.expectRevert();
        reg.registerAgent(KEY, 99, CAP);
        assertFalse(reg.keyUsed(KEY));
        _register();
    }

    // --- owner-only setters ---

    function test_nonOwnerCannotChangeAnything() public {
        uint256 id = _register();
        vm.startPrank(bob);
        vm.expectRevert(PolicyRegistry.NotOwner.selector);
        reg.setCircuit(id, 2);
        vm.expectRevert(PolicyRegistry.NotOwner.selector);
        reg.setDailyCap(id, 1);
        vm.expectRevert(PolicyRegistry.NotOwner.selector);
        reg.setKill(id, true);
        vm.expectRevert(PolicyRegistry.NotOwner.selector);
        reg.rotateKey(id, KEY2);
        vm.expectRevert(PolicyRegistry.NotOwner.selector);
        reg.transferAgent(id, bob);
        vm.stopPrank();
    }

    function test_settersRevertForUnknownAgent() public {
        vm.startPrank(alice);
        vm.expectRevert(PolicyRegistry.UnknownAgent.selector);
        reg.setCircuit(7, 2);
        vm.expectRevert(PolicyRegistry.UnknownAgent.selector);
        reg.setKill(7, true);
        vm.stopPrank();
    }

    function test_setCircuit() public {
        uint256 id = _register();
        vm.expectEmit(address(reg));
        emit CircuitChanged(id, 1, 2);
        vm.prank(alice);
        reg.setCircuit(id, 2);
        assertEq(reg.agent(id).circuitId, 2);
    }

    function test_setCircuitChecksTheCircuit() public {
        uint256 id = _register();
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnknownCircuit.selector, 99));
        reg.setCircuit(id, 99);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.NotAPolicyCircuit.selector, 3));
        reg.setCircuit(id, 3);
        vm.stopPrank();
    }

    function test_setDailyCap() public {
        uint256 id = _register();
        vm.expectEmit(address(reg));
        emit DailyCapChanged(id, CAP, 5);
        vm.prank(alice);
        reg.setDailyCap(id, 5);
        assertEq(reg.dailyCapOf(id), 5);
    }

    function test_killSwitchTogglesBothWays() public {
        uint256 id = _register();
        assertFalse(reg.killed(KEY));

        vm.expectEmit(address(reg));
        emit KillSet(id, true);
        vm.prank(alice);
        reg.setKill(id, true);
        assertTrue(reg.killed(KEY));

        vm.prank(alice);
        reg.setKill(id, false);
        assertFalse(reg.killed(KEY));
    }

    function test_unknownKeyReadsAsKilled() public view {
        assertTrue(reg.killed(keccak256("nobody")));
    }

    // --- rotation and transfer ---

    function test_rotateKeyMovesThePolicy() public {
        uint256 id = _register();
        vm.expectEmit(address(reg));
        emit KeyRotated(id, KEY, KEY2);
        vm.prank(alice);
        reg.rotateKey(id, KEY2);

        assertEq(reg.agentOf(KEY2), id);
        assertEq(reg.agentOf(KEY), 0, "old key unregistered");
        assertTrue(reg.killed(KEY), "old key fails closed");
        assertFalse(reg.killed(KEY2));
        assertEq(reg.agent(id).keyHash, KEY2);
        assertEq(reg.agent(id).circuitId, 1, "settings kept");
    }

    function test_rotatedOutKeyCanNeverReturn() public {
        uint256 id = _register();
        vm.startPrank(alice);
        reg.rotateKey(id, KEY2);
        vm.expectRevert(PolicyRegistry.KeyAlreadyUsed.selector);
        reg.rotateKey(id, KEY);
        vm.expectRevert(PolicyRegistry.KeyAlreadyUsed.selector);
        reg.registerAgent(KEY, 1, CAP);
        vm.stopPrank();
    }

    function test_rotateRejectsZeroAndUsedKeys() public {
        uint256 id = _register();
        vm.prank(bob);
        reg.registerAgent(KEY2, 1, CAP);
        vm.startPrank(alice);
        vm.expectRevert(PolicyRegistry.ZeroKeyHash.selector);
        reg.rotateKey(id, bytes32(0));
        vm.expectRevert(PolicyRegistry.KeyAlreadyUsed.selector);
        reg.rotateKey(id, KEY2);
        vm.stopPrank();
    }

    function test_transferAgent() public {
        uint256 id = _register();
        vm.expectEmit(address(reg));
        emit OwnerChanged(id, alice, bob);
        vm.prank(alice);
        reg.transferAgent(id, bob);
        assertEq(reg.ownerOf(id), bob);

        vm.expectRevert(PolicyRegistry.NotOwner.selector);
        vm.prank(alice);
        reg.setKill(id, true);
        vm.prank(bob);
        reg.setKill(id, true);
    }

    function test_transferRejectsZeroAddress() public {
        uint256 id = _register();
        vm.expectRevert(PolicyRegistry.ZeroAddress.selector);
        vm.prank(alice);
        reg.transferAgent(id, address(0));
    }

    // --- policyOf ---

    function test_policyOfReturnsEverythingTheRouterNeeds() public {
        uint256 id = _register();
        vm.prank(alice);
        reg.setKill(id, true);
        (uint256 agentId, address owner, uint256 circuitId, uint128 cap, bool k) = reg.policyOf(KEY);
        assertEq(agentId, id);
        assertEq(owner, alice);
        assertEq(circuitId, 1);
        assertEq(cap, CAP);
        assertTrue(k);
    }

    function test_policyOfUnknownKeyIsEmpty() public view {
        (uint256 agentId, address owner,,,) = reg.policyOf(KEY);
        assertEq(agentId, 0);
        assertEq(owner, address(0));
    }
}
