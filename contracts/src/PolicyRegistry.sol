// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITapeOutProcessor} from "./interfaces/ITapeOut.sol";

/// @title PolicyRegistry
/// @notice Links each agent's API key to its owner, its policy circuit and its limits.
///
/// An agent is identified by a permanent `agentId`. Its API key is stored only as `keyHash`
/// (keccak256 of the key) and can be rotated without touching the agent's settings or its
/// CreditEscrow balance. A key hash can be registered once, ever: rotated-out hashes stay retired.
///
/// Circuits must live on the PolicyRouter processor and have the policy shape: 6 inputs,
/// 3 outputs, no state. Only the agent's owner can change anything. There is no admin.
contract PolicyRegistry {
    uint32 public constant POLICY_INPUTS = 6;
    uint32 public constant POLICY_OUTPUTS = 3;

    struct Agent {
        address owner;
        uint64 circuitId;
        bool killed;
        uint128 dailyCap; // wei of OKB per UTC day
        bytes32 keyHash;
    }

    ITapeOutProcessor public immutable processor;

    /// @notice Number of agents registered. Agent IDs run from 1 to agentCount.
    uint256 public agentCount;
    mapping(uint256 agentId => Agent) internal _agents;
    /// @notice The agent a live key belongs to; 0 when the key is unknown or rotated out.
    mapping(bytes32 keyHash => uint256 agentId) public agentOf;
    /// @notice Every key hash ever registered, live or retired.
    mapping(bytes32 keyHash => bool) public keyUsed;

    event AgentRegistered(
        uint256 indexed agentId, address indexed owner, bytes32 indexed keyHash, uint256 circuitId, uint128 dailyCap
    );
    event CircuitChanged(uint256 indexed agentId, uint256 oldCircuitId, uint256 newCircuitId);
    event DailyCapChanged(uint256 indexed agentId, uint128 oldCap, uint128 newCap);
    event KillSet(uint256 indexed agentId, bool killed);
    event KeyRotated(uint256 indexed agentId, bytes32 indexed oldKeyHash, bytes32 indexed newKeyHash);
    event OwnerChanged(uint256 indexed agentId, address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error UnknownAgent();
    error ZeroKeyHash();
    error KeyAlreadyUsed();
    error ZeroAddress();
    error UnknownCircuit(uint256 circuitId);
    error NotAPolicyCircuit(uint256 circuitId);

    constructor(ITapeOutProcessor processor_) {
        processor = processor_;
    }

    modifier onlyOwner(uint256 agentId) {
        address o = _agents[agentId].owner;
        if (o == address(0)) revert UnknownAgent();
        if (o != msg.sender) revert NotOwner();
        _;
    }

    // --- writes ---

    function registerAgent(bytes32 keyHash, uint256 circuitId, uint128 dailyCap) external returns (uint256 agentId) {
        _claimKey(keyHash);
        uint64 id = _checkCircuit(circuitId);
        agentId = ++agentCount;
        _agents[agentId] =
            Agent({owner: msg.sender, circuitId: id, killed: false, dailyCap: dailyCap, keyHash: keyHash});
        agentOf[keyHash] = agentId;
        emit AgentRegistered(agentId, msg.sender, keyHash, circuitId, dailyCap);
    }

    function setCircuit(uint256 agentId, uint256 circuitId) external onlyOwner(agentId) {
        uint64 id = _checkCircuit(circuitId);
        Agent storage a = _agents[agentId];
        emit CircuitChanged(agentId, a.circuitId, circuitId);
        a.circuitId = id;
    }

    function setDailyCap(uint256 agentId, uint128 dailyCap) external onlyOwner(agentId) {
        Agent storage a = _agents[agentId];
        emit DailyCapChanged(agentId, a.dailyCap, dailyCap);
        a.dailyCap = dailyCap;
    }

    function setKill(uint256 agentId, bool killed_) external onlyOwner(agentId) {
        _agents[agentId].killed = killed_;
        emit KillSet(agentId, killed_);
    }

    /// @notice Replace the agent's API key. The old key stops working at once and can never return.
    function rotateKey(uint256 agentId, bytes32 newKeyHash) external onlyOwner(agentId) {
        _claimKey(newKeyHash);
        Agent storage a = _agents[agentId];
        bytes32 old = a.keyHash;
        delete agentOf[old];
        agentOf[newKeyHash] = agentId;
        a.keyHash = newKeyHash;
        emit KeyRotated(agentId, old, newKeyHash);
    }

    function transferAgent(uint256 agentId, address newOwner) external onlyOwner(agentId) {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(agentId, msg.sender, newOwner);
        _agents[agentId].owner = newOwner;
    }

    // --- reads ---

    function agent(uint256 agentId) external view returns (Agent memory) {
        return _agents[agentId];
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].owner;
    }

    function dailyCapOf(uint256 agentId) external view returns (uint128) {
        return _agents[agentId].dailyCap;
    }

    /// @notice Everything the router needs about a key, in one call. agentId is 0 for an unknown key.
    function policyOf(bytes32 keyHash)
        external
        view
        returns (uint256 agentId, address owner, uint256 circuitId, uint128 dailyCap, bool killed_)
    {
        agentId = agentOf[keyHash];
        Agent storage a = _agents[agentId];
        return (agentId, a.owner, a.circuitId, a.dailyCap, a.killed);
    }

    /// @notice True if the agent's kill switch is on. Unknown keys read as killed, so callers fail closed.
    function killed(bytes32 keyHash) external view returns (bool) {
        uint256 agentId = agentOf[keyHash];
        return agentId == 0 || _agents[agentId].killed;
    }

    // --- internal ---

    function _claimKey(bytes32 keyHash) internal {
        if (keyHash == bytes32(0)) revert ZeroKeyHash();
        if (keyUsed[keyHash]) revert KeyAlreadyUsed();
        keyUsed[keyHash] = true;
    }

    /// @dev Reverts unless `circuitId` is a policy-shaped circuit on our processor.
    function _checkCircuit(uint256 circuitId) internal view returns (uint64) {
        if (circuitId > type(uint64).max) revert UnknownCircuit(circuitId);
        try processor.circuitInfo(circuitId) returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) {
            if (nIn != POLICY_INPUTS || nOut != POLICY_OUTPUTS || nState != 0 || gateCount == 0) {
                revert NotAPolicyCircuit(circuitId);
            }
        } catch {
            revert UnknownCircuit(circuitId);
        }
        // forge-lint: disable-next-line(unsafe-typecast) checked against uint64 max above
        return uint64(circuitId);
    }
}
