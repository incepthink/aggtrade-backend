import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface BotPortfolioSnapshotAttributes {
  id: number
  execution_id: string
  wallet_address: string
  total_capital_usd: number
  eth_balance: string
  usdc_balance: string
  wbtc_balance: string
  lbtc_balance: string
  timestamp: Date
  created_at?: Date
  updated_at?: Date
}

class BotPortfolioSnapshot
  extends Model<InferAttributes<BotPortfolioSnapshot>, InferCreationAttributes<BotPortfolioSnapshot>>
  implements BotPortfolioSnapshotAttributes
{
  declare id: CreationOptional<number>
  declare execution_id: string
  declare wallet_address: string
  declare total_capital_usd: number
  declare eth_balance: string
  declare usdc_balance: string
  declare wbtc_balance: string
  declare lbtc_balance: string
  declare timestamp: Date
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>
}

BotPortfolioSnapshot.init(
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
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    total_capital_usd: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false
    },
    eth_balance: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false,
      defaultValue: 0
    },
    usdc_balance: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false,
      defaultValue: 0
    },
    wbtc_balance: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false,
      defaultValue: 0
    },
    lbtc_balance: {
      type: DataTypes.DECIMAL(30, 18),
      allowNull: false,
      defaultValue: 0
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
    modelName: 'BotPortfolioSnapshot',
    tableName: 'bot_portfolio_snapshots',
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
        name: 'idx_execution_wallet_time',
        fields: ['execution_id', 'wallet_address', { name: 'timestamp', order: 'ASC' }]
      },
      {
        name: 'idx_timestamp',
        fields: [{ name: 'timestamp', order: 'ASC' }]
      }
    ]
  }
)

export default BotPortfolioSnapshot
