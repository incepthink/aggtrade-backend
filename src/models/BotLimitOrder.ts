import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface BotLimitOrderAttributes {
  id: number
  execution_id: string
  wallet_index: number
  wallet_address: string
  order_id: string
  tx_hash: string
  chain_id: number
  src_token_address: string
  src_token_symbol: string
  src_amount: string
  dst_token_address: string
  dst_token_symbol: string
  dst_min_amount: string
  filled_src_amount: string
  filled_dst_amount: string
  progress: number
  usd_volume: number
  status: 'pending' | 'partial' | 'filled' | 'canceled' | 'expired'
  placed_at: Date
  filled_at: Date | null
  deadline: number | null
  metadata: any
  created_at?: Date
  updated_at?: Date
}

class BotLimitOrder
  extends Model<InferAttributes<BotLimitOrder>, InferCreationAttributes<BotLimitOrder>>
  implements BotLimitOrderAttributes
{
  declare id: CreationOptional<number>
  declare execution_id: string
  declare wallet_index: number
  declare wallet_address: string
  declare order_id: string
  declare tx_hash: string
  declare chain_id: number
  declare src_token_address: string
  declare src_token_symbol: string
  declare src_amount: string
  declare dst_token_address: string
  declare dst_token_symbol: string
  declare dst_min_amount: string
  declare filled_src_amount: string
  declare filled_dst_amount: string
  declare progress: number
  declare usd_volume: number
  declare status: 'pending' | 'partial' | 'filled' | 'canceled' | 'expired'
  declare placed_at: Date
  declare filled_at: Date | null
  declare deadline: number | null
  declare metadata: any
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>
}

BotLimitOrder.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    execution_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
      references: {
        model: 'bot_executions',
        key: 'execution_id'
      },
      onDelete: 'CASCADE'
    },
    wallet_index: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    order_id: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    tx_hash: {
      type: DataTypes.STRING(66),
      allowNull: false
    },
    chain_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 747474
    },
    src_token_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    src_token_symbol: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    src_amount: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false
    },
    dst_token_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    dst_token_symbol: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    dst_min_amount: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false
    },
    filled_src_amount: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false,
      defaultValue: 0
    },
    filled_dst_amount: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false,
      defaultValue: 0
    },
    progress: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0
    },
    usd_volume: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: 0
    },
    status: {
      type: DataTypes.ENUM('pending', 'partial', 'filled', 'canceled', 'expired'),
      allowNull: false,
      defaultValue: 'pending'
    },
    placed_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    filled_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    deadline: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    metadata: {
      type: DataTypes.JSON,
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
    modelName: 'BotLimitOrder',
    tableName: 'bot_limit_orders',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_execution_id',
        fields: ['execution_id']
      },
      {
        name: 'idx_wallet_address',
        fields: ['wallet_address']
      },
      {
        name: 'idx_order_id',
        fields: ['order_id']
      },
      {
        name: 'idx_status',
        fields: ['status']
      },
      {
        name: 'idx_execution_wallet',
        fields: ['execution_id', 'wallet_address']
      }
    ]
  }
)

export default BotLimitOrder
