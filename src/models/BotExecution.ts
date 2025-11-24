import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface BotExecutionAttributes {
  id: number
  execution_id: string
  strategy_name: string
  total_wallets: number
  completed_wallets: number
  failed_wallets: number
  total_volume_usd: number
  start_time: Date
  end_time: Date | null
  status: 'running' | 'completed' | 'failed'
  created_at?: Date
  updated_at?: Date
}

class BotExecution
  extends Model<InferAttributes<BotExecution>, InferCreationAttributes<BotExecution>>
  implements BotExecutionAttributes
{
  declare id: CreationOptional<number>
  declare execution_id: string
  declare strategy_name: string
  declare total_wallets: number
  declare completed_wallets: CreationOptional<number>
  declare failed_wallets: CreationOptional<number>
  declare total_volume_usd: CreationOptional<number>
  declare start_time: Date
  declare end_time: Date | null
  declare status: 'running' | 'completed' | 'failed'
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>
}

BotExecution.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    execution_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true
    },
    strategy_name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    total_wallets: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false
    },
    completed_wallets: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    failed_wallets: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    total_volume_usd: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: 0
    },
    start_time: {
      type: DataTypes.DATE,
      allowNull: false
    },
    end_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('running', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'running'
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
    modelName: 'BotExecution',
    tableName: 'bot_executions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_execution_id',
        fields: ['execution_id'],
        unique: true
      },
      {
        name: 'idx_status',
        fields: ['status']
      },
      {
        name: 'idx_start_time',
        fields: [{ name: 'start_time', order: 'DESC' }]
      }
    ]
  }
)

export default BotExecution
