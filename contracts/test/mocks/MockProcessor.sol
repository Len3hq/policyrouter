// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Stands in for a TapeOut processor in unit tests: only circuitInfo, which PolicyRegistry reads.
/// Unknown ids revert with "no circuit", as the live processor does.
contract MockProcessor {
    struct Info {
        uint32 nIn;
        uint32 nOut;
        uint32 nState;
        uint32 gateCount;
        bool exists;
    }

    mapping(uint256 => Info) internal _info;

    function set(uint256 id, uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) external {
        _info[id] = Info(nIn, nOut, nState, gateCount, true);
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        Info memory i = _info[id];
        require(i.exists, "no circuit");
        return (i.nIn, i.nOut, i.nState, i.gateCount);
    }
}
