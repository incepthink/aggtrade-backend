import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface BotWalletExecutionAttributes {
  id: number
  execution_id: string
  wallet_index: number
  wallet_address: string
  tokens: string[]
  swaps_completed: number
  total_volume_usd: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  error_message: string | null
  start_time: Date | null
  end_time: Date | null
  created_at?: Date
  updated_at?: Date
}

class BotWalletExecution
  extends Model<InferAttributes<BotWalletExecution>, InferCreationAttributes<BotWalletExecution>>
  implements BotWalletExecutionAttributes
{
  declare id: CreationOptional<number>
  declare execution_id: string
  declare wallet_index: number
  declare wallet_address: string
  declare tokens: string[]
  declare swaps_completed: CreationOptional<number>
  declare total_volume_usd: CreationOptional<number>
  declare status: 'pending' | 'running' | 'completed' | 'failed'
  declare error_message: string | null
  declare start_time: Date | null
  declare end_time: Date | null
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>
}

BotWalletExecution.init(
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
    tokens: {
      type: DataTypes.JSON,
      allowNull: false
    },
    swaps_completed: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    total_volume_usd: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: 0
    },
    status: {
      type: DataTypes.ENUM('pending', 'running', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'pending'
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    start_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    end_time: {
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
    modelName: 'BotWalletExecution',
    tableName: 'bot_wallet_executions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_execution_id',
        fields: ['execution_id']
      },
      {
        name: 'idx_execution_wallet',
        fields: ['execution_id', 'wallet_index'],
        unique: true
      },
      {
        name: 'idx_wallet_address',
        fields: ['wallet_address']
      },
      {
        name: 'idx_status',
        fields: ['status']
      }
    ]
  }
)

export default BotWalletExecution
