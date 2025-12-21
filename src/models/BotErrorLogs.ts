import { DataTypes, Model } from 'sequelize'
import sequelize from '../utils/db/sequelize'

class BotErrorLogs extends Model {
  declare id: number
  declare wallet_index: number
  declare wallet_address: string
  declare error_type: string
  declare error_message: string
  declare phase?: string
  declare additional_data?: any
  declare created_at: Date
}

BotErrorLogs.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    wallet_index: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    error_type: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    phase: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    additional_data: {
      type: DataTypes.JSON,
      allowNull: true
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  },
  {
    sequelize,
    tableName: 'bot_error_logs',
    timestamps: false
  }
)

export default BotErrorLogs
