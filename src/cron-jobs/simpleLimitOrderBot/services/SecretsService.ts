/**
 * Secrets Service
 * Handles fetching secrets from AWS Secrets Manager
 *
 * SECURITY: Secrets are NOT cached and NOT logged
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager'
import { KatanaLogger } from '../../../utils/logger'

const PREFIX = '[SecretsService]'

/**
 * Fetch the bot mnemonic from AWS Secrets Manager
 * Secret name is configured via BOT_MNEMONIC_SECRET_NAME env variable
 *
 * SECURITY:
 * - Secret is NOT cached
 * - Secret is NOT logged
 * - Caller should clear the secret from memory after use
 */
export async function getBotMnemonic(): Promise<string | null> {
  const secretName = process.env.BOT_MNEMONIC_SECRET_NAME
  const region = process.env.AWS_REGION || 'us-east-2'

  if (!secretName) {
    KatanaLogger.warn(PREFIX, 'BOT_MNEMONIC_SECRET_NAME not set')
    return null
  }

  KatanaLogger.info(PREFIX, 'Fetching secret from AWS Secrets Manager...')

  try {
    const client = new SecretsManagerClient({ region })

    const response = await client.send(
      new GetSecretValueCommand({
        SecretId: secretName,
        VersionStage: 'AWSCURRENT'
      })
    )

    if (!response.SecretString) {
      KatanaLogger.error(PREFIX, 'Secret is empty')
      return null
    }

    KatanaLogger.info(PREFIX, 'Secret fetched successfully')

    // Return plain string (12 words)
    return response.SecretString

  } catch (error: any) {
    KatanaLogger.error(PREFIX, 'Failed to fetch secret', error.name)
    return null
  }
}
