import { DataTypes, Model } from 'sequelize'
import sequelize from '../utils/db/sequelize'

class BotWalletMetrics extends Model {
  declare id: number
  declare wallet_index: number
  declare wallet_address: string
  declare date: string
  declare orders_placed_grid_buy: number
  declare orders_placed_grid_sell: number
  declare orders_placed_counter_buy: number
  declare orders_placed_counter_sell: number
  declare orders_failed: number
  declare orders_filled: number
  declare volume_usd: string
  declare realized_pnl_usd: string
  declare fill_rate_percent: string
  declare error_count: number
  declare avg_cycle_time_ms: number
  declare total_cycles: number
  declare last_updated: Date
}

BotWalletMetrics.init(
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
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    orders_placed_grid_buy: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    orders_placed_grid_sell: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    orders_placed_counter_buy: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    orders_placed_counter_sell: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    orders_failed: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    orders_filled: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    volume_usd: {
      type: DataTypes.DECIMAL(20, 2),
      defaultValue: 0.00
    },
    realized_pnl_usd: {
      type: DataTypes.DECIMAL(20, 2),
      defaultValue: 0.00
    },
    fill_rate_percent: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00
    },
    error_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    avg_cycle_time_ms: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    total_cycles: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    last_updated: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  },
  {
    sequelize,
    tableName: 'bot_wallet_metrics',
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ['wallet_index', 'date']
      }
    ]
  }
)

export default BotWalletMetrics
