import { Configs } from '@orbs-network/twap-sdk'
import { Address } from 'viem'

// Katana chain ID
export const KATANA_CHAIN_ID = 747474

// TWAP configuration for Katana chain
export const TWAP_CONFIG = {
  ...Configs.SushiKatana,
  minChunkSizeUsd: 5,
}

// TWAP contract address for Katana
export const TWAP_CONTRACT_ADDRESS: Address = Configs.SushiKatana.twapAddress as Address