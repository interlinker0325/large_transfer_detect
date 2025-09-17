const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const https = require('https');
const { Connection, PublicKey } = require('@solana/web3.js');
require('dotenv').config();

// Configuration from environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MIN_TRANSFER_USD = parseFloat(process.env.MIN_TRANSFER_USD) || 4000;
const MONITORED_ADDRESSES = process.env.MONITORED_ADDRESSES ? 
  process.env.MONITORED_ADDRESSES.split(',').map(addr => addr.trim()) : [];
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '660bf508-1b8b-4c5d-86a0-8be2410d0fb5';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// File paths
const WHALES_ADDRESS_FILE = path.join(__dirname, '..', 'whales_address.txt');
const LOG_DIR = path.join(__dirname, 'log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

const now = new Date().toISOString().replace(/[:]/g, '-').replace('T', '_').replace('Z', '');
const logFile = path.join(LOG_DIR, `transfer_monitor_${now}.log`);

const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// DEX program IDs to exclude from transfer detection
const DEX_PROGRAM_IDS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  '6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma', // OKX
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium Liquidity Pool
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium Vault
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium Launchlab
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // Pump Swap
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pumpfun
  'HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o', // Heaven DEX
  '61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH', // Jupiter Order Engine
  'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe', // SOLFI
  'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY', // ZEROFI
  'SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8', // Token Swap
  'BSwp6bEBihVLdqJRKGgzjcGLHkcTuzmSo1TQkHepzH8p', // Bonkswap
  'endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT', // Solayer
  '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx', // Sanctum Infinity
  'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP', // Penguin
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Orca V1
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca V2
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'  // Meteora DAMM v2
]);

// System program ID for SOL transfers
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

// WebSocket URL
const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Track processed transactions to avoid duplicates
const processedTransactions = new Set();

// Track whale addresses to avoid duplicates
const whaleAddresses = new Set();

// Load existing whale addresses
function loadExistingWhaleAddresses() {
  try {
    if (fs.existsSync(WHALES_ADDRESS_FILE)) {
      const content = fs.readFileSync(WHALES_ADDRESS_FILE, 'utf8');
      const addresses = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .filter(line => /^[A-Za-z0-9]{32,44}$/.test(line));
      
      addresses.forEach(addr => whaleAddresses.add(addr));
      console.log(`Loaded ${addresses.length} existing whale addresses`);
      logToFile(`Loaded ${addresses.length} existing whale addresses`);
    }
  } catch (error) {
    console.error('Error loading existing whale addresses:', error.message);
    logToFile(`Error loading existing whale addresses: ${error.message}`);
  }
}

// Logging function
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  fs.appendFile(logFile, logEntry, (err) => {
    if (err) console.error('Failed to write log:', err);
  });
}

// Function to delay execution
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let solPriceCache = { price: 0, timestamp: 0 };
let tokenPriceCache = new Map();
const PRICE_CACHE_DURATION = 300000; // 5 minute cache

// Function to fetch SOL price
async function fetchSOLPrice() {

  // Return cached price if still valid
  if (solPriceCache.price > 0 && (now - solPriceCache.timestamp) < PRICE_CACHE_DURATION) {
    console.log(`Using cached SOL price: $${solPriceCache.price} (${Math.round((now - solPriceCache.timestamp) / 1000)}s old)`);
    return solPriceCache.price;
  }

  try {
    console.log('Fetching fresh SOL price from CoinGecko...');
    logToFile('Fetching fresh SOL price from CoinGecko...');
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await response.json();
    const price = data.solana?.usd || 0;
    
    // Update cache
    solPriceCache = { price, timestamp: now };
    
    console.log(`SOL price updated: $${price}`);
    logToFile(`SOL price updated: $${price}`);
    
    return price;
  } catch (error) {
    console.error('Error fetching SOL price:', error.message);
    logToFile(`Error fetching SOL price: ${error.message}`);
    
    // Return cached price if available, even if expired
    return solPriceCache.price;
  }
}

// Function to fetch token price with caching
async function fetchTokenPrice(mintAddress) {
  const now = Date.now();
  
  // Check cache first
  if (tokenPriceCache.has(mintAddress)) {
    const cached = tokenPriceCache.get(mintAddress);
    if ((now - cached.timestamp) < PRICE_CACHE_DURATION) {
      return cached.price;
    }
  }
  
  try {
    // Use Jupiter API for token prices
    const url = `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mintAccounts: [mintAddress]
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data && data.length > 0) {
      const tokenInfo = data[0];
      
      // Check for price in extensions
      if (tokenInfo.extensions?.price) {
        const price = parseFloat(tokenInfo.extensions.price);
        
        // Update cache
        tokenPriceCache.set(mintAddress, { price, timestamp: now });
        
        console.log(`Token price updated for ${mintAddress}: $${price}`);
        logToFile(`Token price updated for ${mintAddress}: $${price}`);
        
        return price;
      }
      
      // If no price in extensions, return 0 (will use estimated price fallback)
      console.log(`No price in Helius metadata for ${mintAddress}`);
      return 0;
    } else {
      console.warn(`No token metadata found for: ${mintAddress}`);
      return 0;
    }
  } catch (error) {
    console.error(`Error fetching token price from Helius for ${mintAddress}:`, error.message);
    logToFile(`Error fetching token price from Helius for ${mintAddress}: ${error.message}`);
    
    // Return cached price if available
    if (tokenPriceCache.has(mintAddress)) {
      return tokenPriceCache.get(mintAddress).price;
    }
    
    return 0;
  }
}

// Function to get estimated token price for known tokens
function getEstimatedTokenPrice(mintAddress) {
  // Only USDC
  const knownTokens = {
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 1.0 // USDC
  };
  
  return knownTokens[mintAddress] || 0;
}

// Function to get token symbol/name
function getTokenSymbol(mintAddress) {
  const tokenSymbols = {
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  };
  
  return tokenSymbols[mintAddress] || 'tokens';
}

// Resolve owner from token account (ATA)
async function getOwnerFromATA(ataAddress) {
  try {
    const ataPubkey = new PublicKey(ataAddress);
    const accountInfo = await connection.getParsedAccountInfo(ataPubkey);
    if (accountInfo.value === null) {
      throw new Error('ATA account does not exist');
    }
    const parsed = accountInfo.value.data?.parsed;
    const ownerAddress = parsed?.info?.owner || null;
    const mintAddress = parsed?.info?.mint || null;
    return { ownerAddress, mintAddress };
  } catch (error) {
    console.error('Error resolving ATA owner:', error.message);
    logToFile(`Error resolving ATA owner for ${ataAddress}: ${error.message}`);
    return { ownerAddress: null, mintAddress: null };
  }
}

// Function to classify transaction as transfer
function classifyTransferTransaction(transaction) {
  try {
    const { meta } = transaction;
    if (!meta || !meta.logMessages) return { isTransfer: false, type: null };

    // Check if any program ID in the transaction is a DEX program
    const programIds = meta.logMessages
      .filter(log => log.includes('Program'))
      .map(log => {
        const match = log.match(/Program (\w+) invoke/);
        return match ? match[1] : null;
      })
      .filter(id => id);

    // If any program ID is a DEX program, it's not a simple transfer
    for (const programId of programIds) {
      if (DEX_PROGRAM_IDS.has(programId)) {
        return { isTransfer: false, type: null };
      }
    }

    // Check if it's a system program transfer (SOL transfer)
    const hasSystemProgram = programIds.includes(SYSTEM_PROGRAM_ID);
    const hasTokenProgram = programIds.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    
    if (hasSystemProgram && !hasTokenProgram) {
      return { isTransfer: true, type: 'SOL' };
    }
    
    if (hasTokenProgram && !hasSystemProgram) {
      return { isTransfer: true, type: 'TOKEN' };
    }
    
    if (hasSystemProgram && hasTokenProgram) {
      // Mixed transaction - could be SOL + token transfers
      return { isTransfer: true, type: 'MIXED' };
    }
    
    return { isTransfer: false, type: null };
  } catch (error) {
    console.error('Error classifying transaction:', error.message);
    return { isTransfer: false, type: null };
  }
}

// Function to find the largest SOL transfer from the triggering address
function calculateLargestSOLTransfer(transaction, triggeringAddress) {
  try {
    const instructions = transaction.transaction?.message?.instructions || [];
    let maxLamports = 0;
    let destination = null;

      for (const instruction of instructions) {
      if (instruction.program === 'system' && instruction.parsed?.type === 'transfer') {
        const info = instruction.parsed.info || {};
        if (info.source === triggeringAddress) {
          const lamports = info.lamports || 0;
          if (lamports > maxLamports) {
            maxLamports = lamports;
            destination = info.destination || null;
          }
        }
      }
    }

    return { amountSOL: maxLamports / 1e9, destination };
  } catch (error) {
    console.error('Error calculating largest SOL transfer:', error.message);
    return { amountSOL: 0, destination: null };
  }
}

// Function to calculate token transfer amount and get mint address
function calculateTokenTransferAmount(transaction) {
  try {
    const { meta } = transaction;
    if (!meta || !meta.preTokenBalances || !meta.postTokenBalances) {
      return { amount: 0, mint: null, decimals: 6 };
    }

    // Create maps for easy lookup
    const preMap = new Map();
    const postMap = new Map();
    
    meta.preTokenBalances.forEach(balance => {
      const key = `${balance.accountIndex}_${balance.mint}`;
      preMap.set(key, balance);
    });
    
    meta.postTokenBalances.forEach(balance => {
      const key = `${balance.accountIndex}_${balance.mint}`;
      postMap.set(key, balance);
    });
    
    // Find the biggest token transfer
    let maxTransfer = { amount: 0, mint: null, decimals: 6 };
    const allKeys = new Set([...preMap.keys(), ...postMap.keys()]);
    
    allKeys.forEach(key => {
      const pre = preMap.get(key);
      const post = postMap.get(key);
      
      if (pre && post) {
        const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
        const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
        const change = postAmount - preAmount;
        
        if (Math.abs(change) > Math.abs(maxTransfer.amount)) {
          maxTransfer = {
            amount: Math.abs(change),
            mint: pre.mint,
            decimals: pre.uiTokenAmount.decimals || 6
          };
        }
      }
    });
    
    return maxTransfer;
  } catch (error) {
    console.error('Error calculating token transfer amount:', error.message);
    return { amount: 0, mint: null, decimals: 6 };
  }
}

// Function to save whale address to file
function saveWhaleAddress(address) {
  try {
    if (whaleAddresses.has(address)) {
      console.log(`Address ${address} already exists in whales_address.txt`);
      return false;
    }

    whaleAddresses.add(address);
    
    // Append to file
    const content = `${address}\n`;
    fs.appendFileSync(WHALES_ADDRESS_FILE, content, 'utf8');
    
    console.log(`✅ Added new whale address: ${address}`);
    logToFile(`Added new whale address: ${address}`);
    return true;
  } catch (error) {
    console.error('Error saving whale address:', error.message);
    logToFile(`Error saving whale address: ${error.message}`);
    return false;
  }
}

// Function to send Telegram notification
async function sendTelegramNotification(message, signature = null) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE' || 
      !TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID === 'YOUR_CHAT_ID_HERE') {
    console.warn('Telegram bot token or chat ID not configured. Skipping notification.');
    return false;
  }

  const messageData = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  if (signature) {
    messageData.reply_markup = {
      inline_keyboard: [
        [{
          text: "View TX",
          url: `https://solscan.io/tx/${signature}`
        }]
      ]
    };
  }

  const data = JSON.stringify(messageData);

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('Telegram notification sent successfully');
          logToFile('Telegram notification sent successfully');
          resolve(true);
        } else {
          console.error('Failed to send Telegram notification:', res.statusCode, responseData);
          logToFile(`Failed to send Telegram notification: ${res.statusCode} ${responseData}`);
          resolve(false);
        }
      });
    });

    req.on('error', (error) => {
      console.error('Error sending Telegram notification:', error.message);
      logToFile(`Error sending Telegram notification: ${error.message}`);
      resolve(false);
    });

    req.write(data);
    req.end();
  });
}

// Function to get recipient address that matches the specific transfer amount
function getRecipientAddressForTransfer(transaction, transferType, transferAmount, tokenMint = null) {
  try {
    const instructions = transaction.transaction?.message?.instructions || [];
    
    if (transferType === 'SOL') {
      // For SOL transfers, find the instruction with the matching lamports amount
      const targetLamports = Math.round(transferAmount * 1e9); // Convert SOL back to lamports
      
      for (const instruction of instructions) {
        if (instruction.program === 'system' && instruction.parsed?.type === 'transfer') {
          const lamports = instruction.parsed.info?.lamports || 0;
          if (lamports === targetLamports) {
            return instruction.parsed.info?.destination;
          }
        }
      }
      
      // If exact match not found, find the closest match
      let closestMatch = null;
      let closestDiff = Infinity;
      
      for (const instruction of instructions) {
        if (instruction.program === 'system' && instruction.parsed?.type === 'transfer') {
          const lamports = instruction.parsed.info?.lamports || 0;
          const diff = Math.abs(lamports - targetLamports);
          if (diff < closestDiff) {
            closestDiff = diff;
            closestMatch = instruction.parsed.info?.destination;
          }
        }
      }
      
      return closestMatch;
    } else if (transferType === 'TOKEN') {
      // Use the DESTINATION address (actual receiver of tokens)
      for (const instruction of instructions) {
        if (instruction.program === 'spl-token' && instruction.parsed?.type === 'transferChecked') {
          const instructionMint = instruction.parsed.info?.mint;
          const instructionAmount = instruction.parsed.info?.tokenAmount?.uiAmount || 0;
          
          if (instructionMint === tokenMint && Math.abs(instructionAmount - transferAmount) < 0.000001) {
            return instruction.parsed.info?.destination;
          }
        }
      }
      
      // If exact match not found, find the closest match for the specific mint
      let closestMatch = null;
      let closestDiff = Infinity;
      
      for (const instruction of instructions) {
        if (instruction.program === 'spl-token' && instruction.parsed?.type === 'transferChecked') {
          const instructionMint = instruction.parsed.info?.mint;
          const instructionAmount = instruction.parsed.info?.tokenAmount?.uiAmount || 0;
          
          if (instructionMint === tokenMint) {
            const diff = Math.abs(instructionAmount - transferAmount);
            if (diff < closestDiff) {
              closestDiff = diff;
              closestMatch = instruction.parsed.info?.destination;
            }
          }
        }
      }
      
      return closestMatch;
    }
    
    return null;
  } catch (error) {
    console.error('Error getting recipient address for transfer:', error.message);
    return null;
  }
}

// Function to process transfer transaction
async function processTransferTransaction(transactionData, triggeringAddress) {
  try {
    const { transaction, meta } = transactionData.transaction;
    
    if (!meta || !transaction) {
      return null;
    }

    const signature = transaction.signatures?.[0] || 'Unknown';
    const slot = transactionData.slot || 'Unknown';
    const success = meta.err === null;

    if (!success) {
      console.log(`Transaction failed, skipping: ${signature}`);
      return null;
    }

    // Classify the transfer transaction
    const classification = classifyTransferTransaction(transactionData.transaction);
    if (!classification.isTransfer) {
      return null;
    }

    let transferAmount = 0;
    let transferAmountUSD = 0;
    let tokenMint = null;
    let transferType = 'Unknown';

    // Process based on transfer type
    if (classification.type === 'SOL' || classification.type === 'MIXED') {
      // Calculate largest SOL transfer from triggering address
      const { amountSOL, destination } = calculateLargestSOLTransfer(transactionData.transaction, triggeringAddress);
      if (amountSOL > 0) {
        const solPrice = await fetchSOLPrice();
        const solUSD = amountSOL * solPrice;
        
        if (solUSD >= transferAmountUSD) {
          transferAmount = amountSOL;
          transferAmountUSD = solUSD;
          transferType = 'SOL';
        }
      }
    }

    if (classification.type === 'TOKEN' || classification.type === 'MIXED') {
      // Calculate token transfer amount
      const tokenTransfer = calculateTokenTransferAmount(transactionData.transaction);
      if (tokenTransfer.amount > 0 && tokenTransfer.mint) {
        const tokenPrice = await fetchTokenPrice(tokenTransfer.mint);
        // If we couldn't get a price, try to estimate based on known tokens
        let estimatedPrice = tokenPrice;
        if (tokenPrice === 0) {
          // Check if it's a known token with estimated price
          estimatedPrice = getEstimatedTokenPrice(tokenTransfer.mint);
          if (estimatedPrice > 0) {
            console.log(`Using estimated price for ${tokenTransfer.mint}: $${estimatedPrice}`);
            logToFile(`Using estimated price for ${tokenTransfer.mint}: $${estimatedPrice}`);
          }
        }
        
        const tokenUSD = tokenTransfer.amount * estimatedPrice;
        
        if (tokenUSD >= transferAmountUSD) {
          transferAmount = tokenTransfer.amount;
          transferAmountUSD = tokenUSD;
          tokenMint = tokenTransfer.mint;
          transferType = 'TOKEN';
        }
      }
    }

    // Check if transfer meets minimum USD threshold
    if (transferAmountUSD < MIN_TRANSFER_USD) {
      console.log(`Transfer $${transferAmountUSD.toFixed(2)} below threshold $${MIN_TRANSFER_USD}, skipping`);
      return null;
    }

    if (transferType === 'TOKEN' && transferAmountUSD === 0) {
      console.log(`Could not determine USD value for token ${tokenMint}, skipping notification`);
      logToFile(`Could not determine USD value for token ${tokenMint}, skipping notification`);
      return null;
    }

    // If we couldn't determine USD value for token transfer, skip it
    if (transferType === 'TOKEN' && transferAmountUSD === 0) {
      console.log(`Could not determine USD value for token ${tokenMint}, skipping notification`);
      logToFile(`Could not determine USD value for token ${tokenMint}, skipping notification`);
      return null;
    }

    // Get recipient address matching the transfer
    let recipientAddress = null;
    if (transferType === 'SOL') {
      // Recompute to get destination for SOL largest transfer
      const { destination } = calculateLargestSOLTransfer(transactionData.transaction, triggeringAddress);
      recipientAddress = destination;
    } else {
      recipientAddress = getRecipientAddressForTransfer(
        transactionData.transaction, 
        transferType, 
        transferAmount, 
        tokenMint
      );
    }
    if (!recipientAddress) {
      console.log('Could not determine recipient address for the specific transfer amount');
      return null;
    }

    // If USDC token transfer, resolve owner of destination token account and use owner in outputs
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    let recipientDisplayAddress = recipientAddress;
    if (transferType === 'TOKEN' && tokenMint === USDC_MINT) {
      const { ownerAddress } = await getOwnerFromATA(recipientAddress);
      if (ownerAddress) {
        recipientDisplayAddress = ownerAddress;
      }
    }

    // Save recipient as whale address
    const isNewWhale = saveWhaleAddress(recipientDisplayAddress);

    // Format amount display
    const amountDisplay = transferType === 'SOL' 
      ? `${transferAmount.toFixed(6)} SOL`
      : `${transferAmount.toFixed(6)} ${getTokenSymbol(tokenMint)}`;

    // Send simple notification: only the recipient address
    const message = `${recipientDisplayAddress}`;

    await sendTelegramNotification(message, null);

    console.log(`🚨 Large ${transferType} transfer detected: ${amountDisplay} ($${transferAmountUSD.toFixed(2)}) from ${triggeringAddress} to ${recipientDisplayAddress}`);
    logToFile(`Large ${transferType} transfer detected: ${amountDisplay} ($${transferAmountUSD.toFixed(2)}) from ${triggeringAddress} to ${recipientDisplayAddress}`);

    return {
      signature,
      slot,
      transferAmount,
      transferAmountUSD,
      transferType,
      tokenMint,
      from: triggeringAddress,
      to: recipientDisplayAddress,
      isNewWhale
    };

  } catch (error) {
    console.error('Error processing transfer transaction:', error);
    logToFile(`Error processing transfer transaction: ${error.message}`);
    return null;
  }
}

// Initialize WebSocket connection
const ws = new WebSocket(WS_URL);

// Load existing whale addresses
loadExistingWhaleAddresses();

// Function to send subscription request
function sendSubscriptionRequest(ws) {
  if (MONITORED_ADDRESSES.length === 0) {
    console.log('❌ No addresses configured for monitoring');
    return;
  }

  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "transactionSubscribe",
    params: [
      {
        accountInclude: MONITORED_ADDRESSES
      },
      {
        commitment: "processed",
        encoding: "jsonParsed",
        transactionDetails: "full",
        showRewards: true,
        maxSupportedTransactionVersion: 0
      }
    ]
  };

  ws.send(JSON.stringify(request));
  console.log(`📡 Subscribing to ${MONITORED_ADDRESSES.length} addresses for transfer monitoring`);
  logToFile(`Subscribing to ${MONITORED_ADDRESSES.length} addresses: ${MONITORED_ADDRESSES.join(', ')}`);
}

// Function to send ping frames
function startPing(ws) {
  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log('Ping sent');
      logToFile('Ping sent');
    } else {
      clearInterval(interval);
      console.log('Ping interval cleared as WebSocket is no longer open');
      logToFile('Ping interval cleared as WebSocket is no longer open');
    }
  }, 30000);
}

// WebSocket event handlers
ws.on('open', () => {
  console.log('WebSocket connected');
  logToFile('WebSocket connected');
  
  if (MONITORED_ADDRESSES.length > 0) {
    sendSubscriptionRequest(ws);
  } else {
    console.log('⚠️ No addresses configured in MONITORED_ADDRESSES environment variable');
  }
  
  startPing(ws);
});

ws.on('message', async (data) => {
  const messageStr = data.toString('utf8');
  try {
    const messageObj = JSON.parse(messageStr);

    // Check if this is a subscription confirmation
    if (messageObj.id === 1 && messageObj.result !== undefined) {
      console.log(`Subscription confirmed with ID: ${messageObj.result}`);
      logToFile(`Subscription confirmed with ID: ${messageObj.result}`);
      return;
    }

    // Check if this is a transaction notification
    if (messageObj.method === 'transactionNotification' && messageObj.params?.result) {
      const transactionData = messageObj.params.result;
      
      const signature = transactionData.transaction?.transaction?.signatures?.[0];
      if (!signature) {
        console.log('⚠️ No signature found in transaction data');
        return;
      }

      // Check for duplicates
      if (processedTransactions.has(signature)) {
        console.log(`🔄 Duplicate transaction detected, skipping: ${signature}`);
        return;
      }

      processedTransactions.add(signature);

      // Clean up old processed transactions
      if (processedTransactions.size > 1000) {
        const oldestTransactions = Array.from(processedTransactions).slice(0, 100);
        oldestTransactions.forEach(sig => processedTransactions.delete(sig));
        console.log(`🧹 Cleaned up ${oldestTransactions.length} old processed transactions`);
      }

      // Find triggering address
      const { transaction } = transactionData.transaction;
      const accountKeys = transaction?.message?.accountKeys || [];
      const accountAddresses = accountKeys.map(acc => acc.pubkey);
      
      let triggeringAddress = null;
      for (const address of MONITORED_ADDRESSES) {
        if (accountAddresses.includes(address)) {
          triggeringAddress = address;
          break;
        }
      }

      if (!triggeringAddress) {
        console.log('⚠️ Could not determine triggering address');
        return;
      }

      // Process the transaction
      await processTransferTransaction(transactionData, triggeringAddress);
    }
  } catch (error) {
    console.error('Error processing message:', error.message);
    logToFile(`Error processing message: ${error.message}`);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  logToFile(`WebSocket error: ${err.message}`);
});

ws.on('close', (code, reason) => {
  console.log(`WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
  logToFile(`WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down transfer monitor...');
  logToFile('Transfer monitor shutting down');
  ws.close();
  process.exit(0);
});

console.log('🚀 Transfer Monitor started');
console.log(`📊 Monitoring ${MONITORED_ADDRESSES.length} addresses`);
console.log(`💰 Minimum transfer threshold: $${MIN_TRANSFER_USD}`);
console.log(`📁 Whale addresses will be saved to: ${WHALES_ADDRESS_FILE}`);
logToFile('Transfer Monitor started');
