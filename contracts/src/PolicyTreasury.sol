// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITapeOutFactory, ITapeOutProcessor, ITapeOutTransistors} from "./interfaces/ITapeOut.sol";

/// @title PolicyTreasury
/// @notice Creates the PolicyRouter processor through the TapeOut factory in its constructor, so
/// this contract (not a wallet) is the transistor creator and receives every mint payment.
/// Proceeds are split by a fixed, public rule:
///   - `opsBps` of each sweep goes to `ops` for running costs;
///   - the rest stays in `pool`, which pays for free transistors so a new agent owner can tape out
///     their first custom policy (`grant`).
/// Nothing here can be changed after deployment: no owner, no setters, no proxy.
contract PolicyTreasury is ERC1155Holder, ReentrancyGuard {
    uint256 public constant TRANSISTOR_ID = 0;
    uint16 public constant BPS = 10_000;

    ITapeOutFactory public immutable factory;
    ITapeOutTransistors public immutable transistors;
    ITapeOutProcessor public immutable processor;

    /// @notice Receives the running-costs share.
    address public immutable ops;
    /// @notice The only address allowed to hand out first-policy grants.
    address public immutable granter;
    /// @notice Share of each sweep paid to `ops`, in basis points.
    uint16 public immutable opsBps;
    /// @notice Most transistors one address can receive from `grant`.
    uint256 public immutable maxGrant;

    /// @notice OKB reserved for grants.
    uint256 public pool;
    /// @notice OKB owed to `ops`, paid out by `withdrawOps`.
    uint256 public opsOwed;
    /// @notice Mint price this contract paid to itself through grants and has not yet swept back.
    /// It returns to the pool on sweep instead of being split again.
    uint256 public selfMintPending;
    /// @notice Each address can receive one grant.
    mapping(address => bool) public granted;

    event Swept(uint256 received, uint256 toOps, uint256 toPool, uint256 returnedToPool);
    event OpsWithdrawn(address indexed to, uint256 amount);
    event Granted(address indexed to, uint256 amount, uint256 cost);

    error BadBps();
    error ZeroAddress();
    error NothingToSweep();
    error NotGranter();
    error AlreadyGranted();
    error BadGrantAmount();
    error PoolTooSmall();
    error UnexpectedSender();
    error TransferFailed();

    constructor(
        ITapeOutFactory factory_,
        address ops_,
        address granter_,
        uint16 opsBps_,
        uint256 maxGrant_,
        string memory name,
        string memory symbol,
        string memory story,
        uint256 supply,
        uint256 price
    ) payable {
        if (opsBps_ > BPS) revert BadBps();
        if (ops_ == address(0) || granter_ == address(0)) revert ZeroAddress();
        factory = factory_;
        ops = ops_;
        granter = granter_;
        opsBps = opsBps_;
        maxGrant = maxGrant_;
        (address t, address c) = factory_.createCPU{value: msg.value}(name, symbol, story, supply, price);
        transistors = ITapeOutTransistors(t);
        processor = ITapeOutProcessor(c);
    }

    /// @notice Pull mint proceeds from the transistor contract and split them. Anyone may call.
    function sweep() external nonReentrant {
        if (transistors.owed(address(this)) == 0) revert NothingToSweep();
        uint256 before = address(this).balance;
        transistors.withdraw();
        uint256 received = address(this).balance - before;

        uint256 returned = received < selfMintPending ? received : selfMintPending;
        selfMintPending -= returned;
        uint256 fresh = received - returned;
        uint256 toOps = fresh * opsBps / BPS;
        uint256 toPool = fresh - toOps;

        opsOwed += toOps;
        pool += toPool + returned;
        emit Swept(received, toOps, toPool, returned);
    }

    /// @notice Pay the running-costs share to `ops`. Anyone may call; funds only ever go to `ops`.
    function withdrawOps() external nonReentrant {
        uint256 amount = opsOwed;
        opsOwed = 0;
        (bool ok,) = ops.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit OpsWithdrawn(ops, amount);
    }

    /// @notice Mint `amount` transistors from the pool and give them to `to`, once per address.
    function grant(address to, uint256 amount) external nonReentrant {
        if (msg.sender != granter) revert NotGranter();
        if (to == address(0)) revert ZeroAddress();
        if (granted[to]) revert AlreadyGranted();
        if (amount == 0 || amount > maxGrant) revert BadGrantAmount();

        uint256 price = transistors.mintPrice() * amount;
        uint256 cost = price + factory.protocolFee();
        if (cost > pool) revert PoolTooSmall();

        granted[to] = true;
        pool -= cost;
        selfMintPending += price; // the mint price comes back to us as creator
        transistors.mint{value: cost}(TRANSISTOR_ID, amount);
        transistors.safeTransferFrom(address(this), to, TRANSISTOR_ID, amount, "");
        emit Granted(to, amount, cost);
    }

    /// @dev Only the transistor contract pays this contract (on withdraw).
    receive() external payable {
        if (msg.sender != address(transistors)) revert UnexpectedSender();
    }
}
