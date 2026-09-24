// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Test-only 6-decimal ERC-20 fixture. Deploy only to a local EVM or approved
// testnet; it is not a production contract and has deliberately simple minting.
contract MockUSDT {
    string public constant name = "MockUSDT";
    string public constant symbol = "MockUSDT";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);
    function mint(address to, uint256 value) external { balanceOf[to] += value; emit Transfer(address(0), to, value); }
    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        balanceOf[msg.sender] -= value; balanceOf[to] += value; emit Transfer(msg.sender, to, value); return true;
    }
}
