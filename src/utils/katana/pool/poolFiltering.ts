// src/controllers/katana/utils/poolFiltering.ts

import Token from '../../../models/Token';
import { KATANA_CHAIN_ID } from '../constants';

/**
 * Token data with logo URI
 */
interface TokenWithLogo {
  address: string;
  logo_uri: string | null;
}

/**
 * Get set of tradable token addresses from database
 * Returns lowercase addresses for comparison
 */
export async function getTradableTokenAddresses(): Promise<Set<string>> {
  try {
    const tokens = await Token.findAll({
      attributes: ['address'],
      where: {
        chain_id: KATANA_CHAIN_ID,
        tradable: true,
      },
      raw: true,
    });

    // Create Set of lowercase addresses for fast lookup
    const addressSet = new Set<string>(
      tokens.map((token: any) => token.address.toLowerCase())
    );

    console.log(`[Pool Filtering] Loaded ${addressSet.size} tradable token addresses`);
    
    return addressSet;
  } catch (error) {
    console.error('[Pool Filtering] Error fetching tradable tokens:', error);
    // Return empty set on error to fail gracefully
    return new Set<string>();
  }
}

/**
 * Get map of token addresses to logo URIs
 * Returns lowercase addresses as keys
 */
export async function getTokenLogos(): Promise<Map<string, string | null>> {
  try {
    const tokens = await Token.findAll({
      attributes: ['address', 'logo_uri'],
      where: {
        chain_id: KATANA_CHAIN_ID,
        tradable: true,
      },
      raw: true,
    });

    // Create Map of lowercase address -> logo_uri
    const logoMap = new Map<string, string | null>(
      tokens.map((token: TokenWithLogo) => [
        token.address.toLowerCase(),
        token.logo_uri,
      ])
    );

    console.log(`[Pool Filtering] Loaded ${logoMap.size} token logos`);
    
    return logoMap;
  } catch (error) {
    console.error('[Pool Filtering] Error fetching token logos:', error);
    // Return empty map on error to fail gracefully
    return new Map<string, string | null>();
  }
}