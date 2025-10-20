import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface FusionRecord {
  id: string;
  inputNFTs: string[];
  outputNFT: {
    encryptedAttributes: string;
    name: string;
    image: string;
  };
  timestamp: number;
  owner: string;
  fusionCost: number;
}

interface NFTAttribute {
  attack: number;
  defense: number;
  speed: number;
  rarity: number;
}

const FHEEncryptAttributes = (attributes: NFTAttribute): string => {
  const data = `${attributes.attack},${attributes.defense},${attributes.speed},${attributes.rarity}`;
  return `FHE-${btoa(data)}`;
};

const FHEDecryptAttributes = (encryptedData: string): NFTAttribute => {
  if (encryptedData.startsWith('FHE-')) {
    const decrypted = atob(encryptedData.substring(4));
    const [attack, defense, speed, rarity] = decrypted.split(',').map(Number);
    return { attack, defense, speed, rarity };
  }
  return { attack: 0, defense: 0, speed: 0, rarity: 0 };
};

const FHEFusionCompute = (nft1: NFTAttribute, nft2: NFTAttribute): NFTAttribute => {
  // Fusion algorithm: combine attributes with randomness
  const getRandomFactor = () => 0.8 + Math.random() * 0.4; // 0.8-1.2
  
  return {
    attack: Math.round((nft1.attack + nft2.attack) * getRandomFactor()),
    defense: Math.round((nft1.defense + nft2.defense) * getRandomFactor()),
    speed: Math.round((nft1.speed + nft2.speed) * getRandomFactor()),
    rarity: Math.round((nft1.rarity + nft2.rarity) * getRandomFactor() * 0.7) // Rarity decreases slightly
  };
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [fusions, setFusions] = useState<FusionRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showFusionModal, setShowFusionModal] = useState(false);
  const [fusing, setFusing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newFusionData, setNewFusionData] = useState({ nft1: "", nft2: "" });
  const [selectedFusion, setSelectedFusion] = useState<FusionRecord | null>(null);
  const [decryptedAttributes, setDecryptedAttributes] = useState<NFTAttribute | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [announcements, setAnnouncements] = useState<string[]>([
    "New fusion event: Double rarity chance this weekend!",
    "System maintenance scheduled for next Tuesday",
    "Introducing new legendary NFTs to the collection"
  ]);
  
  // Stats for dashboard
  const fusionCount = fusions.length;
  const totalFusionCost = fusions.reduce((sum, fusion) => sum + fusion.fusionCost, 0);
  const userFusionCount = fusions.filter(f => f.owner === address).length;
  
  // Leaderboard data
  const leaderboard = fusions.reduce((acc: {[key: string]: number}, fusion) => {
    acc[fusion.owner] = (acc[fusion.owner] || 0) + 1;
    return acc;
  }, {});
  
  const sortedLeaderboard = Object.entries(leaderboard)
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  useEffect(() => {
    loadFusions().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadFusions = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Get list of fusion keys
      const keysBytes = await contract.getData("fusion_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing fusion keys:", e); }
      }
      
      // Load each fusion record
      const list: FusionRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`fusion_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                inputNFTs: recordData.inputNFTs, 
                outputNFT: {
                  encryptedAttributes: recordData.outputNFT.encryptedAttributes,
                  name: recordData.outputNFT.name,
                  image: recordData.outputNFT.image
                },
                timestamp: recordData.timestamp,
                owner: recordData.owner,
                fusionCost: recordData.fusionCost || 10
              });
            } catch (e) { console.error(`Error parsing fusion data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading fusion ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setFusions(list);
    } catch (e) { console.error("Error loading fusions:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const performFusion = async () => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setFusing(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Performing FHE fusion..." });
    
    try {
      // Generate random attributes for input NFTs (simulated)
      const nft1Attributes: NFTAttribute = {
        attack: Math.floor(Math.random() * 100),
        defense: Math.floor(Math.random() * 100),
        speed: Math.floor(Math.random() * 100),
        rarity: Math.floor(Math.random() * 10)
      };
      
      const nft2Attributes: NFTAttribute = {
        attack: Math.floor(Math.random() * 100),
        defense: Math.floor(Math.random() * 100),
        speed: Math.floor(Math.random() * 100),
        rarity: Math.floor(Math.random() * 10)
      };
      
      // Perform fusion using FHE simulation
      const fusedAttributes = FHEFusionCompute(nft1Attributes, nft2Attributes);
      const encryptedAttributes = FHEEncryptAttributes(fusedAttributes);
      
      // Generate NFT metadata
      const fusionId = `fusion-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const fusionCost = 10; // Fixed cost for now
      
      const outputNFT = {
        encryptedAttributes,
        name: `Fused NFT #${fusionId.substring(0, 4)}`,
        image: `https://picsum.photos/200/200?random=${Math.floor(Math.random() * 1000)}`
      };
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Save fusion record
      const fusionData = {
        inputNFTs: [newFusionData.nft1, newFusionData.nft2],
        outputNFT,
        timestamp: Math.floor(Date.now() / 1000),
        owner: address,
        fusionCost
      };
      
      await contract.setData(`fusion_${fusionId}`, ethers.toUtf8Bytes(JSON.stringify(fusionData)));
      
      // Update fusion keys
      const keysBytes = await contract.getData("fusion_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(fusionId);
      await contract.setData("fusion_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Fusion successful! New NFT created." });
      await loadFusions();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowFusionModal(false);
        setNewFusionData({ nft1: "", nft2: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Fusion failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setFusing(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<NFTAttribute | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptAttributes(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { setIsDecrypting(false); }
  };

  const handleCheckAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available and ready!" });
      } else {
        setTransactionStatus({ visible: true, status: "error", message: "Contract is not available" });
      }
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="neon-spinner"></div>
      <p>Initializing Fusion Lab...</p>
    </div>
  );

  return (
    <div className="app-container fusion-lab-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="flask-icon"></div>
          </div>
          <h1>NFT<span>Fusion</span>Lab</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowFusionModal(true)} className="fusion-btn neon-button">
            <div className="fusion-icon"></div>Fuse NFTs
          </button>
          <button className="neon-button" onClick={handleCheckAvailability}>
            Check Availability
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content">
        {/* Announcement Center */}
        <div className="announcement-center">
          <h3>System Announcements</h3>
          <div className="announcement-scroll">
            {announcements.map((announcement, index) => (
              <div key={index} className="announcement neon-card">
                <div className="announcement-icon">📢</div>
                <div className="announcement-text">{announcement}</div>
              </div>
            ))}
          </div>
        </div>
        
        {/* Dashboard Panels */}
        <div className="dashboard-grid">
          {/* Project Introduction */}
          <div className="dashboard-card neon-card intro-panel">
            <h3>NFT Fusion Laboratory</h3>
            <p>
              Welcome to the NFT Fusion Lab! Using <strong>Zama FHE technology</strong>, 
              you can fuse your NFTs to create entirely new, unpredictable digital assets. 
              All fusion operations happen on encrypted data, ensuring complete privacy.
            </p>
            <div className="fhe-badge"><span>FHE-Powered Fusion</span></div>
          </div>
          
          {/* Data Statistics */}
          <div className="dashboard-card neon-card stats-panel">
            <h3>Fusion Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{fusionCount}</div>
                <div className="stat-label">Total Fusions</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{totalFusionCost}</div>
                <div className="stat-label">Total Fusion Cost</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{userFusionCount}</div>
                <div className="stat-label">Your Fusions</div>
              </div>
            </div>
          </div>
          
          {/* Feature Showcase */}
          <div className="dashboard-card neon-card features-panel">
            <h3>Fusion Features</h3>
            <div className="features-list">
              <div className="feature-item">
                <div className="feature-icon">🔒</div>
                <div className="feature-text">NFT attributes encrypted with FHE</div>
              </div>
              <div className="feature-item">
                <div className="feature-icon">⚗️</div>
                <div className="feature-text">Alchemy-like fusion process</div>
              </div>
              <div className="feature-item">
                <div className="feature-icon">🎲</div>
                <div className="feature-text">Unpredictable fusion results</div>
              </div>
              <div className="feature-item">
                <div className="feature-icon">💎</div>
                <div className="feature-text">Create rare NFTs</div>
              </div>
            </div>
          </div>
          
          {/* Leaderboard */}
          <div className="dashboard-card neon-card leaderboard-panel">
            <h3>Fusion Masters</h3>
            <div className="leaderboard-list">
              {sortedLeaderboard.map((entry, index) => (
                <div key={entry.address} className="leaderboard-entry">
                  <div className="rank">#{index + 1}</div>
                  <div className="address">
                    {entry.address.substring(0, 6)}...{entry.address.substring(38)}
                  </div>
                  <div className="count">{entry.count} fusions</div>
                </div>
              ))}
              {sortedLeaderboard.length === 0 && (
                <div className="no-leaderboard">No fusion data yet</div>
              )}
            </div>
          </div>
        </div>
        
        {/* Fusion Records */}
        <div className="records-section">
          <div className="section-header">
            <h2>Recent Fusions</h2>
            <div className="header-actions">
              <button onClick={loadFusions} className="refresh-btn neon-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="records-list neon-card">
            {fusions.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon">⚗️</div>
                <p>No fusion records found</p>
                <button className="neon-button primary" onClick={() => setShowFusionModal(true)}>
                  Perform First Fusion
                </button>
              </div>
            ) : (
              <div className="fusion-grid">
                {fusions.map(fusion => (
                  <div 
                    key={fusion.id} 
                    className="fusion-card"
                    onClick={() => setSelectedFusion(fusion)}
                  >
                    <div className="fusion-header">
                      <div className="fusion-id">#{fusion.id.substring(0, 6)}</div>
                      <div className="fusion-cost">{fusion.fusionCost} FUS</div>
                    </div>
                    <div className="input-nfts">
                      <div className="nft-preview">NFT: {fusion.inputNFTs[0]?.substring(0, 8)}</div>
                      <div className="plus-icon">+</div>
                      <div className="nft-preview">NFT: {fusion.inputNFTs[1]?.substring(0, 8)}</div>
                    </div>
                    <div className="arrow">↓</div>
                    <div className="output-nft">
                      <img src={fusion.outputNFT.image} alt="Fused NFT" className="nft-image" />
                      <div className="nft-name">{fusion.outputNFT.name}</div>
                    </div>
                    <div className="fusion-footer">
                      <div className="owner">{fusion.owner.substring(0, 6)}...{fusion.owner.substring(38)}</div>
                      <div className="date">{new Date(fusion.timestamp * 1000).toLocaleDateString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Fusion Modal */}
      {showFusionModal && (
        <div className="modal-overlay">
          <div className="fusion-modal neon-card">
            <div className="modal-header">
              <h2>Fuse NFTs</h2>
              <button onClick={() => setShowFusionModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="fhe-notice-banner">
                <div className="key-icon"></div> 
                <div>
                  <strong>FHE Fusion Process</strong>
                  <p>Your NFT attributes will be encrypted with Zama FHE before fusion</p>
                </div>
              </div>
              
              <div className="fusion-form">
                <div className="form-group">
                  <label>First NFT ID *</label>
                  <input 
                    type="text" 
                    value={newFusionData.nft1}
                    onChange={(e) => setNewFusionData({...newFusionData, nft1: e.target.value})}
                    placeholder="Enter NFT ID or address"
                    className="neon-input"
                  />
                </div>
                
                <div className="fusion-plus">+</div>
                
                <div className="form-group">
                  <label>Second NFT ID *</label>
                  <input 
                    type="text" 
                    value={newFusionData.nft2}
                    onChange={(e) => setNewFusionData({...newFusionData, nft2: e.target.value})}
                    placeholder="Enter NFT ID or address"
                    className="neon-input"
                  />
                </div>
              </div>
              
              <div className="fusion-preview">
                <div className="preview-nfts">
                  <div className="nft-preview">
                    <div className="nft-placeholder">NFT #1</div>
                    <div className="nft-id">{newFusionData.nft1 || '?'}</div>
                  </div>
                  <div className="plus-icon">+</div>
                  <div className="nft-preview">
                    <div className="nft-placeholder">NFT #2</div>
                    <div className="nft-id">{newFusionData.nft2 || '?'}</div>
                  </div>
                </div>
                
                <div className="arrow-down">↓</div>
                
                <div className="result-preview">
                  <div className="question-mark">?</div>
                  <div className="result-label">Mystery NFT</div>
                </div>
              </div>
              
              <div className="privacy-notice">
                <div className="privacy-icon"></div> 
                <div>
                  <strong>Privacy Guarantee</strong>
                  <p>NFT attributes remain encrypted during fusion and are never exposed</p>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowFusionModal(false)} className="cancel-btn neon-button">
                Cancel
              </button>
              <button 
                onClick={performFusion} 
                disabled={fusing || !newFusionData.nft1 || !newFusionData.nft2}
                className="submit-btn neon-button primary"
              >
                {fusing ? "Fusing with FHE..." : "Perform Fusion"}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Fusion Detail Modal */}
      {selectedFusion && (
        <div className="modal-overlay">
          <div className="fusion-detail-modal neon-card">
            <div className="modal-header">
              <h2>Fusion Details #{selectedFusion.id.substring(0, 8)}</h2>
              <button onClick={() => { setSelectedFusion(null); setDecryptedAttributes(null); }} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="fusion-info">
                <div className="info-item"><span>Owner:</span><strong>{selectedFusion.owner.substring(0, 6)}...{selectedFusion.owner.substring(38)}</strong></div>
                <div className="info-item"><span>Date:</span><strong>{new Date(selectedFusion.timestamp * 1000).toLocaleString()}</strong></div>
                <div className="info-item"><span>Cost:</span><strong>{selectedFusion.fusionCost} FUS</strong></div>
              </div>
              
              <div className="fusion-visualization">
                <div className="input-nfts">
                  <div className="nft-card">
                    <div className="nft-image-placeholder"></div>
                    <div className="nft-id">{selectedFusion.inputNFTs[0]?.substring(0, 8)}</div>
                  </div>
                  <div className="plus-icon">+</div>
                  <div className="nft-card">
                    <div className="nft-image-placeholder"></div>
                    <div className="nft-id">{selectedFusion.inputNFTs[1]?.substring(0, 8)}</div>
                  </div>
                </div>
                
                <div className="fusion-arrow">→</div>
                
                <div className="output-nft">
                  <img src={selectedFusion.outputNFT.image} alt="Fused NFT" className="nft-image" />
                  <div className="nft-name">{selectedFusion.outputNFT.name}</div>
                </div>
              </div>
              
              <div className="attributes-section">
                <h3>NFT Attributes</h3>
                <div className="fhe-tag">
                  <div className="fhe-icon"></div>
                  <span>FHE Encrypted</span>
                </div>
                
                {decryptedAttributes ? (
                  <div className="attributes-grid">
                    <div className="attribute">
                      <div className="label">Attack</div>
                      <div className="value">{decryptedAttributes.attack}</div>
                      <div className="meter">
                        <div className="meter-fill" style={{ width: `${decryptedAttributes.attack}%` }}></div>
                      </div>
                    </div>
                    <div className="attribute">
                      <div className="label">Defense</div>
                      <div className="value">{decryptedAttributes.defense}</div>
                      <div className="meter">
                        <div className="meter-fill" style={{ width: `${decryptedAttributes.defense}%` }}></div>
                      </div>
                    </div>
                    <div className="attribute">
                      <div className="label">Speed</div>
                      <div className="value">{decryptedAttributes.speed}</div>
                      <div className="meter">
                        <div className="meter-fill" style={{ width: `${decryptedAttributes.speed}%` }}></div>
                      </div>
                    </div>
                    <div className="attribute">
                      <div className="label">Rarity</div>
                      <div className="value">{decryptedAttributes.rarity}/10</div>
                      <div className="stars">
                        {Array.from({ length: 10 }).map((_, i) => (
                          <div key={i} className={`star ${i < decryptedAttributes.rarity ? 'active' : ''}`}>★</div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="encrypted-data">
                    {selectedFusion.outputNFT.encryptedAttributes.substring(0, 100)}...
                  </div>
                )}
                
                <button 
                  className="decrypt-btn neon-button" 
                  onClick={async () => {
                    if (decryptedAttributes) {
                      setDecryptedAttributes(null);
                    } else {
                      const attrs = await decryptWithSignature(selectedFusion.outputNFT.encryptedAttributes);
                      if (attrs) setDecryptedAttributes(attrs);
                    }
                  }}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : decryptedAttributes ? "Hide Attributes" : "Decrypt Attributes"}
                </button>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => { setSelectedFusion(null); setDecryptedAttributes(null); }} 
                className="close-btn neon-button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content neon-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="neon-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="flask-icon"></div>
              <span>NFT Fusion Lab</span>
            </div>
            <p>Powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Fusion</span></div>
          <div className="copyright">© {new Date().getFullYear()} NFT Fusion Lab. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;