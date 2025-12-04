pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract NFTFusionGameFiFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error NotEnoughNFTs();
    error InvalidNFT();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AlreadyInitialized();
    error NotInitialized();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event NFTSubmitted(address indexed owner, uint256 indexed tokenId, uint256 batchId);
    event FusionRequested(uint256 indexed requestId, uint256 batchId, uint256 stateHash);
    event FusionCompleted(uint256 indexed requestId, uint256 batchId, uint256 newTokenId, uint256[3] attributes);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct NFTData {
        euint32 attr1;
        euint32 attr2;
        euint32 attr3;
        bool initialized;
    }

    struct Batch {
        bool isOpen;
        uint256 numNFTs;
        mapping(uint256 => address) nftOwners;
        mapping(uint256 => NFTData) nftData;
    }

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    mapping(uint256 => DecryptionContext) public decryptionContexts;
    uint256 public lastTokenId;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkCooldown(bool isSubmission) {
        uint256 cooldown = isSubmission ? lastSubmissionTime[msg.sender] : lastRequestTime[msg.sender];
        if (block.timestamp < cooldown + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        cooldownSeconds = 30; 
        currentBatchId = 1;
        lastTokenId = 0;
    }

    function addProvider(address _provider) external onlyOwner {
        isProvider[_provider] = true;
        emit ProviderAdded(_provider);
    }

    function removeProvider(address _provider) external onlyOwner {
        delete isProvider[_provider];
        emit ProviderRemoved(_provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        emit CooldownSet(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function openBatch() external onlyOwner {
        currentBatchId++;
        batches[currentBatchId].isOpen = true;
        batches[currentBatchId].numNFTs = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner {
        if (!batches[currentBatchId].isOpen) revert BatchClosed();
        batches[currentBatchId].isOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitNFT(
        euint32 _attr1,
        euint32 _attr2,
        euint32 _attr3
    ) external onlyProvider whenNotPaused checkCooldown(true) {
        if (!batches[currentBatchId].isOpen) revert BatchClosed();
        if (!_attr1.isInitialized() || !_attr2.isInitialized() || !_attr3.isInitialized()) revert NotInitialized();

        uint256 nftIndex = batches[currentBatchId].numNFTs;
        batches[currentBatchId].nftOwners[nftIndex] = msg.sender;
        batches[currentBatchId].nftData[nftIndex] = NFTData(_attr1, _attr2, _attr3, true);
        batches[currentBatchId].numNFTs++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit NFTSubmitted(msg.sender, nftIndex, currentBatchId);
    }

    function fuseNFTs(uint256 _batchId) external onlyProvider whenNotPaused checkCooldown(false) {
        if (_batchId == 0 || _batchId > currentBatchId) revert InvalidBatch();
        Batch storage batch = batches[_batchId];
        if (batch.numNFTs < 2) revert NotEnoughNFTs();

        euint32 memory attr1_sum = FHE.asEuint32(0);
        euint32 memory attr2_sum = FHE.asEuint32(0);
        euint32 memory attr3_sum = FHE.asEuint32(0);

        for (uint256 i = 0; i < batch.numNFTs; i++) {
            NFTData storage nft = batch.nftData[i];
            if (!nft.initialized) revert InvalidNFT();
            attr1_sum = attr1_sum.add(nft.attr1);
            attr2_sum = attr2_sum.add(nft.attr2);
            attr3_sum = attr3_sum.add(nft.attr3);
        }
        attr1_sum = attr1_sum.div(FHE.asEuint32(batch.numNFTs));
        attr2_sum = attr2_sum.div(FHE.asEuint32(batch.numNFTs));
        attr3_sum = attr3_sum.div(FHE.asEuint32(batch.numNFTs));

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = attr1_sum.toBytes32();
        cts[1] = attr2_sum.toBytes32();
        cts[2] = attr3_sum.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: _batchId,
            stateHash: stateHash,
            processed: false
        });

        lastRequestTime[msg.sender] = block.timestamp;
        emit FusionRequested(requestId, _batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        Batch storage batch = batches[decryptionContexts[requestId].batchId];
        uint256 numNFTs = batch.numNFTs;

        euint32 memory attr1_sum = FHE.asEuint32(0);
        euint32 memory attr2_sum = FHE.asEuint32(0);
        euint32 memory attr3_sum = FHE.asEuint32(0);

        for (uint256 i = 0; i < numNFTs; i++) {
            NFTData storage nft = batch.nftData[i];
            if (!nft.initialized) revert InvalidNFT();
            attr1_sum = attr1_sum.add(nft.attr1);
            attr2_sum = attr2_sum.add(nft.attr2);
            attr3_sum = attr3_sum.add(nft.attr3);
        }
        attr1_sum = attr1_sum.div(FHE.asEuint32(numNFTs));
        attr2_sum = attr2_sum.div(FHE.asEuint32(numNFTs));
        attr3_sum = attr3_sum.div(FHE.asEuint32(numNFTs));

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = attr1_sum.toBytes32();
        cts[1] = attr2_sum.toBytes32();
        cts[2] = attr3_sum.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 attr1 = abi.decode(cleartexts, (uint256));
        uint256 attr2 = abi.decode(cleartexts[32:], (uint256));
        uint256 attr3 = abi.decode(cleartexts[64:], (uint256));

        lastTokenId++;
        decryptionContexts[requestId].processed = true;

        emit FusionCompleted(
            requestId,
            decryptionContexts[requestId].batchId,
            lastTokenId,
            [attr1, attr2, attr3]
        );
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 memory val, uint256 plainVal) internal pure returns (euint32 memory) {
        if (!val.isInitialized()) {
            return FHE.asEuint32(plainVal);
        }
        return val;
    }

    function _requireInitialized(euint32 memory val) internal pure {
        if (!val.isInitialized()) revert NotInitialized();
    }
}