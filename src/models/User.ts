import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface UserAttributes {
  id: number
  wallet_address: string
  chain_id: number
  is_active: boolean
  token_addresses: string[]
  last_balance_check: Date | null
  created_at?: Date
  updated_at?: Date
}

class User
  extends Model<InferAttributes<User>, InferCreationAttributes<User>>
  implements UserAttributes
{
  declare id: CreationOptional<number>
  declare wallet_address: string
  declare chain_id: number
  declare is_active: boolean
  declare token_addresses: string[]
  declare last_balance_check: Date | null
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Static method to find user by wallet address
  static async findByWallet(walletAddress: string, chainId: number = 747474) {
    return this.findOne({
      where: {
        wallet_address: walletAddress.toLowerCase(),
        chain_id: chainId
      }
    })
  }

  // Static method to get all active users
  static async getActiveUsers(chainId: number = 747474) {
    return this.findAll({
      where: {
        is_active: true,
        chain_id: chainId
      },
      raw: true
    })
  }

  // Static method to create or get user
  static async findOrCreateUser(walletAddress: string, chainId: number = 747474) {
    const [user, created] = await this.findOrCreate({
      where: {
        wallet_address: walletAddress.toLowerCase(),
        chain_id: chainId
      },
      defaults: {
        wallet_address: walletAddress.toLowerCase(),
        chain_id: chainId,
        is_active: true,
        token_addresses: [],
        last_balance_check: null
      }
    })
    
    return { user, created }
  }

  // Static method to update last balance check time
  static async updateLastCheck(walletAddress: string, chainId: number = 747474) {
    return this.update(
      { last_balance_check: new Date() },
      {
        where: {
          wallet_address: walletAddress.toLowerCase(),
          chain_id: chainId
        }
      }
    )
  }

  // Static method to add token addresses for a user
  static async addTokenAddresses(
    walletAddress: string, 
    tokenAddresses: string[], 
    chainId: number = 747474
  ) {
    const user = await this.findByWallet(walletAddress, chainId)
    
    if (!user) {
      throw new Error('User not found')
    }

    // Normalize addresses to lowercase
    const normalizedTokens = tokenAddresses.map(addr => addr.toLowerCase())
    
    // Get existing tokens and merge with new ones (remove duplicates)
    const existingTokens = user.token_addresses || []
    const uniqueTokens = [...new Set([...existingTokens, ...normalizedTokens])]
    
    await user.update({ token_addresses: uniqueTokens })
    
    return user
  }

  // Static method to update/replace token addresses for a user
  static async updateTokenAddresses(
    walletAddress: string, 
    tokenAddresses: string[], 
    chainId: number = 747474
  ) {
    const normalizedTokens = tokenAddresses.map(addr => addr.toLowerCase())
    
    return this.update(
      { token_addresses: normalizedTokens },
      {
        where: {
          wallet_address: walletAddress.toLowerCase(),
          chain_id: chainId
        }
      }
    )
  }

  // Static method to remove specific token addresses
  static async removeTokenAddresses(
    walletAddress: string, 
    tokenAddresses: string[], 
    chainId: number = 747474
  ) {
    const user = await this.findByWallet(walletAddress, chainId)
    
    if (!user) {
      throw new Error('User not found')
    }

    const tokensToRemove = tokenAddresses.map(addr => addr.toLowerCase())
    const updatedTokens = (user.token_addresses || []).filter(
      token => !tokensToRemove.includes(token.toLowerCase())
    )
    
    await user.update({ token_addresses: updatedTokens })
    
    return user
  }

  // Static method to clear all token addresses
  static async clearTokenAddresses(walletAddress: string, chainId: number = 747474) {
    return this.update(
      { token_addresses: [] },
      {
        where: {
          wallet_address: walletAddress.toLowerCase(),
          chain_id: chainId
        }
      }
    )
  }

  // Static method to deactivate user
  static async deactivateUser(walletAddress: string, chainId: number = 747474) {
    return this.update(
      { is_active: false },
      {
        where: {
          wallet_address: walletAddress.toLowerCase(),
          chain_id: chainId
        }
      }
    )
  }
}

User.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false,
      validate: {
        is: /^0x[a-fA-F0-9]{40}$/
      }
    },
    chain_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 747474
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    token_addresses: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: []
    },
    last_balance_check: {
      type: DataTypes.DATE,
      allowNull: true
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    }
  },
  {
    sequelize,
    modelName: 'User',
    tableName: 'users',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_wallet_chain_unique',
        fields: ['wallet_address', 'chain_id'],
        unique: true
      },
      {
        name: 'idx_wallet_address',
        fields: ['wallet_address']
      },
      {
        name: 'idx_chain_id',
        fields: ['chain_id']
      },
      {
        name: 'idx_is_active',
        fields: ['is_active']
      },
      {
        name: 'idx_chain_active',
        fields: ['chain_id', 'is_active']
      }
    ]
  }
)

export default User