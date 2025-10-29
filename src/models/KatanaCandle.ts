// models/KatanaCandle.ts
import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface KatanaCandleAttributes {
  id: number
  token_address: string
  pool_id: string
  pool_token0_address: string
  pool_token0_symbol: string
  pool_token1_address: string
  pool_token1_symbol: string
  pool_fee_tier: number
  is_token0: boolean
  timeframe: string // '5m'
  timestamp: Date
  open: number
  high: number
  low: number
  close: number
  volume: number
  created_at?: Date
  updated_at?: Date
}

class KatanaCandle
  extends Model<InferAttributes<KatanaCandle>, InferCreationAttributes<KatanaCandle>>
  implements KatanaCandleAttributes
{
  declare id: CreationOptional<number>
  declare token_address: string
  declare pool_id: string
  declare pool_token0_address: string
  declare pool_token0_symbol: string
  declare pool_token1_address: string
  declare pool_token1_symbol: string
  declare pool_fee_tier: number
  declare is_token0: boolean
  declare timeframe: string
  declare timestamp: Date
  declare open: number
  declare high: number
  declare low: number
  declare close: number
  declare volume: number
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Get candles for a specific token and time range
  static async getCandles(
    tokenAddress: string,
    poolId: string,
    startDate: Date,
    endDate: Date,
    timeframe: string = '5m'
  ) {
    return this.findAll({
      attributes: [
        'timestamp',
        'open',
        'high',
        'low',
        'close',
        'volume'
      ],
      where: {
        token_address: tokenAddress.toLowerCase(),
        pool_id: poolId.toLowerCase(),
        timeframe,
        timestamp: {
          [Op.between]: [startDate, endDate]
        }
      },
      order: [['timestamp', 'DESC']],
      raw: true
    })
  }
}

KatanaCandle.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    token_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    pool_id: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
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
    is_token0: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    timeframe: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: '5m'
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false
    },
    open: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false
    },
    high: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false
    },
    low: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false
    },
    close: {
      type: DataTypes.DECIMAL(36, 18),
      allowNull: false
    },
    volume: {
      type: DataTypes.DECIMAL(36, 18),
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
    modelName: 'KatanaCandle',
    tableName: 'katana_candles',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      // Primary index for queries
      {
        name: 'idx_token_timeframe_timestamp',
        fields: [
          'token_address',
          'timeframe',
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // Pool-based queries
      {
        name: 'idx_pool_timeframe_timestamp',
        fields: [
          'pool_id',
          'timeframe',
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // Unique constraint: one candle per token per timeframe per timestamp
      {
        name: 'idx_unique_candle',
        unique: true,
        fields: ['token_address', 'pool_id', 'timeframe', 'timestamp']
      }
    ]
  }
)

export default KatanaCandle