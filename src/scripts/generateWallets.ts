import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

interface WalletInfo {
  name: string;
  address: string;
  privateKey: string;
  mnemonic: string;
}

async function generateWallets(count: number): Promise<void> {
  const wallets: WalletInfo[] = [];

  console.log(`Starting wallet generation for ${count} wallets...\n`);

  try {
    for (let i = 1; i <= count; i++) {
      const walletName = `WALLET_${String(i).padStart(3, '0')}`;

      try {
        // Generate a random wallet with mnemonic
        const wallet = ethers.Wallet.createRandom();

        // Extract wallet information
        const walletInfo: WalletInfo = {
          name: walletName,
          address: wallet.address,
          privateKey: wallet.privateKey,
          mnemonic: wallet.mnemonic?.phrase || 'N/A'
        };

        wallets.push(walletInfo);

        // Log progress every 10 wallets
        if (i % 10 === 0) {
          console.log(`Progress: ${i}/${count} wallets generated (${((i/count) * 100).toFixed(1)}%)`);
        }

      } catch (error) {
        console.error(`Error generating ${walletName}:`, error);
        throw error;
      }
    }

    console.log(`\nSuccessfully generated all ${count} wallets!`);

    // Save to JSON file
    const outputPath = path.join(__dirname, 'wallets.json');
    fs.writeFileSync(outputPath, JSON.stringify(wallets, null, 2), 'utf-8');

    console.log(`\nWallets saved to: ${outputPath}`);
    console.log(`File size: ${(fs.statSync(outputPath).size / 1024).toFixed(2)} KB`);

    // Display first wallet as sample
    console.log('\nSample (First Wallet):');
    console.log(JSON.stringify(wallets[0], null, 2));

    console.log('\n=== IMPORTANT SECURITY NOTICE ===');
    console.log('This file contains private keys and seed phrases.');
    console.log('Keep it secure and delete it after use.');
    console.log('Never share or commit this file to version control.');
    console.log('=================================\n');

  } catch (error) {
    console.error('\nFatal error during wallet generation:', error);
    throw error;
  }
}

// Run the script
const WALLET_COUNT = 100;

generateWallets(WALLET_COUNT)
  .then(() => {
    console.log('Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });