// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// The demo's two contracts. Compiled once into contracts.json, so running the
// demo needs no Solidity toolchain. Neither is safe for anything but a local
// chain: neither checks who may move what.

/** An ERC-721 as the detector sees one: nothing but its Transfer events. */
contract DemoNFT {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function move(address from, address to, uint256 tokenId) external {
        emit Transfer(from, to, tokenId);
    }
}

/**
 * Stands in for Seaport 1.6: the demo writes this code at Seaport's own
 * address, so a sale here is tagged and priced exactly as one on mainnet.
 * Emits OrderFulfilled for a listing: the token offered, the price owed.
 */
contract DemoSeaport {
    struct SpentItem { uint8 itemType; address token; uint256 identifier; uint256 amount; }
    struct ReceivedItem { uint8 itemType; address token; uint256 identifier; uint256 amount; address recipient; }

    event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, SpentItem[] offer, ReceivedItem[] consideration);

    function sale(DemoNFT nft, address seller, uint256 tokenId) external payable {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(2, address(nft), tokenId, 1);
        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(0, address(0), 0, msg.value, seller);
        emit OrderFulfilled(keccak256(abi.encode(nft, tokenId, block.number)), seller, address(0), msg.sender, offer, consideration);
        nft.move(seller, msg.sender, tokenId);
        payable(seller).transfer(msg.value);
    }
}
