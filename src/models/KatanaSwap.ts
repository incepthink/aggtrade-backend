// models/KatanaSwap.ts
import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface KatanaSwapAttributes {
  id: string
  pool_id: string
  pool_token0_address: string
  pool_token0_symbol: string
  pool_token1_address: string
  pool_token1_symbol: string
  pool_fee_tier: number
  token_address: string
  is_token0: boolean
  timestamp: Date
  block_number: number
  token_price_usd: number
  token_volume_usd: number
  total_volume_usd: number
  tx_hash: string
  created_at?: Date
  updated_at?: Date
}

class KatanaSwap
  extends Model<InferAttributes<KatanaSwap>, InferCreationAttributes<KatanaSwap>>
  implements KatanaSwapAttributes
{
  declare id: string
  declare pool_id: string
  declare pool_token0_address: string
  declare pool_token0_symbol: string
  declare pool_token1_address: string
  declare pool_token1_symbol: string
  declare pool_fee_tier: number
  declare token_address: string
  declare is_token0: boolean
  declare timestamp: Date
  declare block_number: number
  declare token_price_usd: number
  declare token_volume_usd: number
  declare total_volume_usd: number
  declare tx_hash: string
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Static method for optimized OHLC queries
  static async getOHLCData(
    tokenAddress: string,
    startDate: Date,
    endDate: Date,
    limit: number = 10000
  ) {
    return this.findAll({
      attributes: [
        'timestamp',
        'token_price_usd',
        'token_volume_usd',
        'total_volume_usd'
      ],
      where: {
        token_address: tokenAddress.toLowerCase(),
        timestamp: {
          [Op.between]: [startDate, endDate] 
        }
      },
      order: [['timestamp', 'DESC']],
      limit,
      raw: true // Return plain objects for better performance
    })
  }

  // Static method for recent swaps (Redis replacement)
  static async getRecentSwaps(tokenAddress: string, limit: number = 5000) {
    return this.findAll({
      attributes: [
        'id',
        'timestamp', 
        'token_price_usd',
        'token_volume_usd',
        'total_volume_usd'
      ],
      where: {
        token_address: tokenAddress.toLowerCase()
      },
      order: [['timestamp', 'DESC']],
      limit,
      raw: true
    })
  }
}

KatanaSwap.init(
  {
    id: {
      type: DataTypes.STRING(66),
      primaryKey: true
    },
    pool_id: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    // Denormalized pool data for fast queries (no JOINs needed)
    pool_token0_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    pool_token0_symbol: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    pool_token1_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    pool_token1_symbol: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    pool_fee_tier: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    // Core swap data
    token_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    is_token0: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false
    },
    block_number: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    // Price/volume data - optimized for chart queries
    token_price_usd: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false
    },
    token_volume_usd: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false
    },
    total_volume_usd: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false
    },
    tx_hash: {
      type: DataTypes.STRING(66),
      allowNull: false
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
    modelName: 'KatanaSwap',
    tableName: 'katana_swaps',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      // PRIMARY INDEX: Token + Time (DESC) - Critical for OHLC queries
      {
        name: 'idx_token_timestamp_desc',
        fields: [
          'token_address', 
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // COVERING INDEX: Include price/volume for index-only scans
      {
        name: 'idx_token_time_price_volume',
        fields: [
          'token_address',
          { name: 'timestamp', order: 'DESC' },
          'token_price_usd',
          'token_volume_usd'
        ]
      },
      // Pool-based queries
      {
        name: 'idx_pool_timestamp_desc', 
        fields: [
          'pool_id',
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // Time-only index for partition pruning
      {
        name: 'idx_timestamp_desc',
        fields: [{ name: 'timestamp', order: 'DESC' }]
      },
      // Block number for sync tracking
      {
        name: 'idx_block_number',
        fields: ['block_number']
      },
      // Transaction hash lookups
      {
        name: 'idx_tx_hash',
        fields: ['tx_hash']
      }
    ],
    // Enable compression for large datasets
    // options: {
    //   engine: 'InnoDB',
    //   charset: 'utf8mb4',
    //   collate: 'utf8mb4_unicode_ci',
    //   // Row compression
    //   rowFormat: 'COMPRESSED',
    //   keyBlockSize: 8
    // }
  }
)

export default KatanaSwap