// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ITapeOutFactory, ITapeOutProcessor, ITapeOutTransistors} from "../../src/interfaces/ITapeOut.sol";

/// Creates a processor from its constructor, so the contract (not a wallet) is the creator.
contract CreatorProbe {
    address public transistors;
    address public circuits;

    constructor(ITapeOutFactory factory, uint256 supply, uint256 price) payable {
        (transistors, circuits) = factory.createCPU{value: msg.value}("Probe", "PRB", "creator probe", supply, price);
    }
}

/// Phase 0 spikes against the LIVE TapeOut contracts on an X Layer fork. Nothing is broadcast.
///   forge test --match-path "test/fork/*" --fork-url https://rpc.xlayer.tech -vv
/// Skipped automatically when not forking X Layer.
contract TapeOutSpikeTest is Test {
    ITapeOutFactory constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    uint256 constant SUPPLY = 1_000_000;
    uint256 constant PRICE = 0.0001 ether; // 0.0001 OKB, as proposed in the spec

    address deployer = makeAddr("deployer");
    address user = makeAddr("user");

    function setUp() public {
        vm.skip(block.chainid != 196);
        vm.deal(deployer, 10 ether);
        vm.deal(user, 10 ether);
    }

    function _createFromWallet() internal returns (ITapeOutTransistors trans, ITapeOutProcessor proc) {
        uint256 fee = FACTORY.deployFee(); // read before prank: prank only covers the next call
        vm.prank(deployer);
        (address t, address c) = FACTORY.createCPU{value: fee}("PolicyRouter", "PRT", "spike", SUPPLY, PRICE);
        return (ITapeOutTransistors(t), ITapeOutProcessor(c));
    }

    function test_factoryIsDeployed() public view {
        assertGt(address(FACTORY).code.length, 0);
        console2.log("deployFee   (wei)", FACTORY.deployFee());
        console2.log("protocolFee (wei)", FACTORY.protocolFee());
    }

    function test_walletCanCreateProcessor() public {
        (ITapeOutTransistors trans, ITapeOutProcessor proc) = _createFromWallet();
        assertTrue(FACTORY.isCPU(address(proc)));
        assertEq(trans.creator(), deployer);
        assertEq(trans.circuits(), address(proc));
        assertEq(proc.transistors(), address(trans));
        assertEq(trans.supplyCap(), SUPPLY);
        assertEq(trans.mintPrice(), PRICE);
        assertTrue(trans.supportsInterface(0xd9b67a26), "transistors are ERC-1155");
        console2.log("TAPEOUT_FEE (wei)", proc.TAPEOUT_FEE());
    }

    function test_contractCanBeCreator() public {
        uint256 fee = FACTORY.deployFee();
        vm.prank(deployer);
        CreatorProbe probe = new CreatorProbe{value: fee}(FACTORY, SUPPLY, PRICE);
        assertTrue(FACTORY.isCPU(probe.circuits()));
        assertEq(ITapeOutTransistors(probe.transistors()).creator(), address(probe));
    }

    /// Does the creator receive the full mint price, with the protocol fee charged on top?
    function test_mintPaysCreatorInFull() public {
        (ITapeOutTransistors trans,) = _createFromWallet();
        uint256 amount = 20;
        uint256 owedBefore = trans.owed(deployer);
        uint256 protocolFee = FACTORY.protocolFee();
        vm.prank(user);
        trans.mint{value: PRICE * amount + protocolFee}(0, amount);
        assertEq(trans.balanceOf(user, 0), amount);
        assertEq(trans.minted(), amount);
        assertEq(trans.owed(deployer) - owedBefore, PRICE * amount, "creator owed the full mint price");

        uint256 balBefore = deployer.balance;
        vm.prank(deployer);
        trans.withdraw();
        assertEq(deployer.balance - balBefore, PRICE * amount);
    }

    /// Tape out a 2-gate circuit: out0 = NOT pin0, out1 = NOT pin5. Then confirm the pin layout.
    function test_evalPinPacking() public {
        (ITapeOutTransistors trans, ITapeOutProcessor proc) = _createFromWallet();
        // pins 0..5 are signals 2..7. NAND(2,2) -> signal 8, NAND(7,7) -> signal 9. Outputs = last 2 signals.
        bytes memory nl = hex"00000002000002" hex"00000007000007";

        vm.startPrank(user);
        trans.mint{value: PRICE * 2 + FACTORY.protocolFee()}(0, 2);
        uint256 id = proc.tapeout{value: proc.TAPEOUT_FEE()}(nl, 6, 2);
        vm.stopPrank();

        assertEq(trans.balanceOf(user, 0), 0, "one transistor burned per gate");
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = proc.circuitInfo(id);
        assertEq(nIn, 6);
        assertEq(nOut, 2);
        assertEq(nState, 0);
        assertEq(gates, 2);
        assertEq(proc.ownerOf(id), user);

        // pin i = bit (i % 8) of byte (i >> 3), least significant bit first
        assertEq(proc.eval(id, hex"00"), hex"03"); // both pins 0 -> both outputs 1
        assertEq(proc.eval(id, hex"01"), hex"02"); // pin0 = 1 -> out0 = 0
        assertEq(proc.eval(id, hex"20"), hex"01"); // pin5 = 1 -> out1 = 0
        assertEq(proc.eval(id, hex"21"), hex"00");
        console2.log("circuit id", id);
    }
}
