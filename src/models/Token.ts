// models/Token.ts
import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface TokenAttributes {
  id: number
  address: string
  symbol: string
  name: string
  decimals: number
  total_supply: string | null
  pool_count: number
  tradable: boolean
  chain_id: number
  logo_uri: string | null
  created_at?: Date
  updated_at?: Date
}

class Token
  extends Model<InferAttributes<Token>, InferCreationAttributes<Token>>
  implements TokenAttributes
{
  declare id: CreationOptional<number>
  declare address: string
  declare symbol: string
  declare name: string
  declare decimals: number
  declare total_supply: string | null
  declare pool_count: number
  declare tradable: boolean
  declare chain_id: number
  declare logo_uri: string | null
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Static method to get all tradable tokens
  static async getTradableTokens(chainId: number = 747474) {
    return this.findAll({
      where: {
        tradable: true,
        chain_id: chainId
      },
      order: [['symbol', 'ASC']],
      raw: true
    })
  }

  // Static method to find token by address
  static async findByAddress(address: string, chainId: number = 747474) {
    return this.findOne({
      where: {
        address: address.toLowerCase(),
        chain_id: chainId
      }
    })
  }

  // Static method to bulk upsert tokens from subgraph data
  static async bulkUpsertTokens(tokens: Partial<TokenAttributes>[]) {
    const results = []
    
    for (const tokenData of tokens) {
      const [token, created] = await this.upsert({
        address: tokenData.address!.toLowerCase(),
        symbol: tokenData.symbol!,
        name: tokenData.name!,
        decimals: tokenData.decimals!,
        total_supply: tokenData.total_supply || null,
        pool_count: tokenData.pool_count || 0,
        chain_id: tokenData.chain_id || 747474,
        tradable: tokenData.tradable !== undefined ? tokenData.tradable : true
      })
      
      results.push({ token, created })
    }
    
    return results
  }

  // Static method to update tradable status
  static async updateTradableStatus(address: string, tradable: boolean, chainId: number = 747474) {
    return this.update(
      { tradable },
      {
        where: {
          address: address.toLowerCase(),
          chain_id: chainId
        }
      }
    )
  }

  // Static method to search tokens by symbol or name
  static async searchTokens(query: string, chainId: number = 747474, limit: number = 50) {
    return this.findAll({
      where: {
        chain_id: chainId,
        tradable: true,
        [Op.or]: [
          { symbol: { [Op.like]: `%${query}%` } },
          { name: { [Op.like]: `%${query}%` } }
        ]
      },
      order: [['pool_count', 'DESC'], ['symbol', 'ASC']],
      limit,
      raw: true
    })
  }

  // Static method to get tokens with minimum pool count
  static async getTokensWithMinPools(minPoolCount: number = 1, chainId: number = 747474) {
    return this.findAll({
      where: {
        chain_id: chainId,
        tradable: true,
        pool_count: { [Op.gte]: minPoolCount }
      },
      order: [['pool_count', 'DESC']],
      raw: true
    })
  }
}

Token.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    address: {
      type: DataTypes.STRING(42),
      allowNull: false,
      validate: {
        is: /^0x[a-fA-F0-9]{40}$/
      }
    },
    symbol: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    decimals: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      validate: {
        min: 0,
        max: 255
      }
    },
    total_supply: {
      type: DataTypes.STRING(78), // Large number as string
      allowNull: true
    },
    pool_count: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    tradable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    chain_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 747474 // Katana chain ID
    },
    logo_uri: {
      type: DataTypes.STRING,
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
    modelName: 'Token',
    tableName: 'tokens',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      // Unique constraint on address + chain_id
      {
        name: 'idx_address_chain_unique',
        fields: ['address', 'chain_id'],
        unique: true
      },
      // Index for address lookups
      {
        name: 'idx_address',
        fields: ['address']
      },
      // Index for symbol searches
      {
        name: 'idx_symbol',
        fields: ['symbol']
      },
      // Index for chain_id filtering
      {
        name: 'idx_chain_id',
        fields: ['chain_id']
      },
      // Index for tradable filtering
      {
        name: 'idx_tradable',
        fields: ['tradable']
      },
      // Composite index for main queries (tradable tokens by chain)
      {
        name: 'idx_chain_tradable_pools',
        fields: ['chain_id', 'tradable', 'pool_count']
      },
      // Index for search functionality
      {
        name: 'idx_symbol_name_search',
        fields: ['symbol', 'name']
      },
      // Index for creation tracking
      {
        name: 'idx_created_at',
        fields: ['created_at']
      }
    ]
  }
)

export default Token