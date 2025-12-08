import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface SushiswapActivityAttributes {
  id: number
  user_id: number
  wallet_address: string
  swap_type: 'CLASSIC' | 'LIMIT_ORDER'
  tx_hash: string
  chain_id: number
  block_number: number | null
  block_timestamp: Date | null
  token_from_address: string
  token_from_symbol: string
  token_from_amount: string
  token_to_address: string
  token_to_symbol: string
  token_to_amount: string
  usd_volume: number
  fees_usd: number | null
  execution_price: number
  pool_id: string | null
  order_id: string | null
  filled_src_amount: string | null
  filled_dst_amount: string | null
  is_partial_fill: boolean
  progress: number | null
  status: string
  metadata: any
  timestamp: Date
  created_at?: Date
  updated_at?: Date
}

class SushiswapActivity
  extends Model<InferAttributes<SushiswapActivity>, InferCreationAttributes<SushiswapActivity>>
  implements SushiswapActivityAttributes
{
  declare id: CreationOptional<number>
  declare user_id: number
  declare wallet_address: string
  declare swap_type: 'CLASSIC' | 'LIMIT_ORDER'
  declare tx_hash: string
  declare chain_id: number
  declare block_number: number | null
  declare block_timestamp: Date | null
  declare token_from_address: string
  declare token_from_symbol: string
  declare token_from_amount: string
  declare token_to_address: string
  declare token_to_symbol: string
  declare token_to_amount: string
  declare usd_volume: number
  declare fees_usd: number | null
  declare execution_price: number
  declare pool_id: string | null
  declare order_id: string | null
  declare filled_src_amount: string | null
  declare filled_dst_amount: string | null
  declare is_partial_fill: boolean
  declare progress: number | null
  declare status: string
  declare metadata: any
  declare timestamp: Date
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>
}

SushiswapActivity.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      },
      onDelete: 'CASCADE'
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    swap_type: {
      type: DataTypes.ENUM('CLASSIC', 'LIMIT_ORDER'),
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
    block_number: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    block_timestamp: {
      type: DataTypes.DATE,
      allowNull: true
    },
    token_from_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    token_from_symbol: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    token_from_amount: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false
    },
    token_to_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    token_to_symbol: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    token_to_amount: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false
    },
    usd_volume: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: 0
    },
    fees_usd: {
      type: DataTypes.DECIMAL(20, 8),
      allowNull: true,
      defaultValue: 0
    },
    execution_price: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false
    },
    pool_id: {
      type: DataTypes.STRING(42),
      allowNull: true
    },
    order_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'For limit orders: unique order ID'
    },
    filled_src_amount: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: true,
      comment: 'For limit orders: actual executed source amount'
    },
    filled_dst_amount: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: true,
      comment: 'For limit orders: actual received destination amount'
    },
    is_partial_fill: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'For limit orders: whether this is a partial fill'
    },
    progress: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'For limit orders: percentage filled (0-100)'
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'success'
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Additional swap-specific data'
    },
    timestamp: {
      type: DataTypes.DATE,
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
    modelName: 'SushiswapActivity',
    tableName: 'sushiswap_activity',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_tx_hash_unique',
        fields: ['tx_hash'],
        unique: true
      },
      {
        name: 'idx_user_timestamp',
        fields: ['user_id', { name: 'timestamp', order: 'DESC' }]
      },
      {
        name: 'idx_wallet_timestamp',
        fields: ['wallet_address', { name: 'timestamp', order: 'DESC' }]
      },
      {
        name: 'idx_swap_type',
        fields: ['swap_type']
      },
      {
        name: 'idx_user_swap_type',
        fields: ['user_id', 'swap_type']
      },
      {
        name: 'idx_token_from',
        fields: ['token_from_address']
      },
      {
        name: 'idx_token_to',
        fields: ['token_to_address']
      },
      {
        name: 'idx_order_id',
        fields: ['order_id']
      },
      {
        name: 'idx_chain_id',
        fields: ['chain_id']
      },
      {
        name: 'idx_timestamp',
        fields: [{ name: 'timestamp', order: 'DESC' }]
      }
    ]
  }
)

export default SushiswapActivity
