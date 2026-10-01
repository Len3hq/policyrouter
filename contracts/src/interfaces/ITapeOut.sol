// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The TapeOut contracts on X Layer mainnet (chain 196), as PolicyRouter uses them.
/// Adapted from Fabrica's interface (github.com/seekdaseek/fabrica, MIT) and checked against
/// the live contracts in test/fork/TapeOutSpike.t.sol.
///
/// Factory 0x1f09DAeFA827f02CBb40967cc91b259763760761 (ERC-1967 proxy).
/// Processors ("circuits", ERC-721) are beacon proxies on 0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C.
/// Transistor contracts (ERC-1155, token id 0) are beacon proxies on 0x1059AD62CaBB6A6925bb65AA617300556C60A51b.
///
/// Netlist format read by tapeout():
///   signal 0 = constant 0, signal 1 = constant 1, signals 2 .. 2+nIn-1 = input pins,
///   then one new signal per element, in order.
///   NAND  = 0x00 a:u24 b:u24 (7 bytes)
///   LATCH = 0x01 d:u24       (4 bytes)
///   The outputs are the LAST nOut signals.
/// Pin layout for eval(): pin i is bit (i % 8) of byte (i >> 3).

interface ITapeOutFactory {
    function createCPU(
        string calldata name,
        string calldata symbol,
        string calldata story,
        uint256 transistorSupply,
        uint256 mintPrice
    ) external payable returns (address transistors, address circuits);

    function deployFee() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function isCPU(address circuits) external view returns (bool);
}

interface ITapeOutProcessor {
    function eval(uint256 circuitId, bytes calldata input) external view returns (bytes memory);
    function circuitInfo(uint256 circuitId)
        external
        view
        returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
    function netlist(uint256 circuitId) external view returns (bytes memory);
    function ownerOf(uint256 circuitId) external view returns (address);
    function transistors() external view returns (address);
    function nextId() external view returns (uint256);
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
}

interface ITapeOutTransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function mintPrice() external view returns (uint256);
    function supplyCap() external view returns (uint256);
    function minted() external view returns (uint256);
    function owed(address account) external view returns (uint256);
    function withdraw() external;
    function creator() external view returns (address);
    function circuits() external view returns (address);
    function story() external view returns (string memory);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}
