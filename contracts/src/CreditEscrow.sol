// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PolicyRegistry} from "./PolicyRegistry.sol";

/// @title CreditEscrow
/// @notice Holds each agent's prepaid OKB, tracks what it spent today, and lets the router settle
/// usage in batches. Each batch's Merkle root of request receipts is stored with its block number,
/// so anyone can prove a receipt was part of a settled batch.
///
/// Rules that hold no matter what the router sends:
///   - a settle never debits more than an agent's balance;
///   - a settle never pushes an agent's spend for the day past its daily cap;
///   - only the agent's owner can deposit or withdraw, and withdrawals go to the owner.
/// An entry that would break a rule is debited only up to the limit and the rest is reported as a
/// Shortfall. It does not revert, so one agent cannot block a whole batch.
/// There is no admin. `router` and `payee` are fixed at deployment.
contract CreditEscrow is ReentrancyGuard {
    struct Account {
        uint128 balance;
        uint128 spent; // spent on `day`
        uint64 day; // UTC day number: block.timestamp / 1 days
    }

    struct Entry {
        uint256 agentId;
        uint256 cost; // wei of OKB
    }

    struct Batch {
        bytes32 root;
        uint64 blockNumber;
    }

    PolicyRegistry public immutable registry;
    /// @notice The only address that can settle.
    address public immutable router;
    /// @notice Receives settled usage fees.
    address public immutable payee;

    mapping(uint256 agentId => Account) internal _accounts;
    mapping(uint256 batchId => Batch) internal _batches;
    /// @notice Batches are numbered 0, 1, 2… and must be settled in order, each exactly once.
    uint256 public nextBatchId;
    /// @notice Sum of every agent's balance.
    uint256 public totalBalances;
    /// @notice Settled fees not yet paid to `payee`.
    uint256 public earned;

    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event Debited(uint256 indexed batchId, uint256 indexed agentId, uint256 amount);
    event Shortfall(uint256 indexed batchId, uint256 indexed agentId, uint256 amount);
    event Settled(uint256 indexed batchId, bytes32 root, uint256 entries, uint256 debited);
    event EarningsClaimed(address indexed payee, uint256 amount);

    error NotAgentOwner();
    error NotRouter();
    error ZeroAmount();
    error InsufficientBalance();
    error WrongBatchId(uint256 expected);
    error ZeroAddress();
    error TransferFailed();

    constructor(PolicyRegistry registry_, address router_, address payee_) {
        if (router_ == address(0) || payee_ == address(0)) revert ZeroAddress();
        registry = registry_;
        router = router_;
        payee = payee_;
    }

    modifier onlyAgentOwner(uint256 agentId) {
        if (registry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _;
    }

    // --- owner ---

    function deposit(uint256 agentId) external payable onlyAgentOwner(agentId) {
        if (msg.value == 0) revert ZeroAmount();
        _accounts[agentId].balance += SafeCast.toUint128(msg.value);
        totalBalances += msg.value;
        emit Deposited(agentId, msg.sender, msg.value);
    }

    function withdraw(uint256 agentId, uint256 amount) external nonReentrant onlyAgentOwner(agentId) {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[agentId];
        if (amount > a.balance) revert InsufficientBalance();
        // forge-lint: disable-next-line(unsafe-typecast) amount <= a.balance, a uint128
        a.balance -= uint128(amount);
        totalBalances -= amount;
        emit Withdrawn(agentId, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // --- router ---

    function settle(uint256 batchId, bytes32 root, Entry[] calldata entries) external nonReentrant {
        if (msg.sender != router) revert NotRouter();
        if (batchId != nextBatchId) revert WrongBatchId(nextBatchId);
        nextBatchId = batchId + 1;
        _batches[batchId] = Batch({root: root, blockNumber: uint64(block.number)});

        uint256 total;
        for (uint256 i = 0; i < entries.length; i++) {
            total += _debit(batchId, entries[i].agentId, entries[i].cost);
        }
        totalBalances -= total;
        earned += total;
        emit Settled(batchId, root, entries.length, total);
    }

    /// @notice Pay settled fees to `payee`. Anyone may call; the money only ever goes to `payee`.
    function claimEarnings() external nonReentrant {
        uint256 amount = earned;
        earned = 0;
        emit EarningsClaimed(payee, amount);
        (bool ok,) = payee.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // --- reads ---

    function balanceOf(uint256 agentId) external view returns (uint256) {
        return _accounts[agentId].balance;
    }

    function spentToday(uint256 agentId) public view returns (uint256) {
        Account storage a = _accounts[agentId];
        return a.day == _today() ? a.spent : 0;
    }

    /// @notice True if the agent has a balance and today's spend is under its daily cap.
    function budgetOk(uint256 agentId) public view returns (bool) {
        return _accounts[agentId].balance > 0 && spentToday(agentId) < registry.dailyCapOf(agentId);
    }

    /// @notice budgetOk for an API key hash; false for an unknown key, so callers fail closed.
    function budgetOkForKey(bytes32 keyHash) external view returns (bool) {
        uint256 agentId = registry.agentOf(keyHash);
        return agentId != 0 && budgetOk(agentId);
    }

    function batch(uint256 batchId) external view returns (bytes32 root, uint64 blockNumber) {
        Batch storage b = _batches[batchId];
        return (b.root, b.blockNumber);
    }

    /// @notice True if `receiptHash` is a leaf of a settled batch. Leaves use the OpenZeppelin
    /// merkle-tree library's StandardMerkleTree encoding for a single bytes32 value.
    function isInBatch(uint256 batchId, bytes32 receiptHash, bytes32[] calldata proof) external view returns (bool) {
        if (batchId >= nextBatchId) return false;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(receiptHash))));
        return MerkleProof.verifyCalldata(proof, _batches[batchId].root, leaf);
    }

    // --- internal ---

    function _today() internal view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    /// @dev Debits min(cost, balance, room left under today's cap) and reports any shortfall.
    function _debit(uint256 batchId, uint256 agentId, uint256 cost) internal returns (uint256 debit) {
        Account storage a = _accounts[agentId];
        uint64 today = _today();
        if (a.day != today) {
            a.day = today;
            a.spent = 0;
        }
        uint256 cap = registry.dailyCapOf(agentId);
        uint256 room = cap > a.spent ? cap - a.spent : 0;
        debit = cost;
        if (debit > a.balance) debit = a.balance;
        if (debit > room) debit = room;

        if (debit > 0) {
            // forge-lint: disable-next-line(unsafe-typecast) debit <= a.balance, a uint128
            a.balance -= uint128(debit);
            // forge-lint: disable-next-line(unsafe-typecast) debit <= room <= cap, a uint128
            a.spent += uint128(debit);
            emit Debited(batchId, agentId, debit);
        }
        if (debit < cost) emit Shortfall(batchId, agentId, cost - debit);
    }
}
