import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op
} from 'sequelize'
import sequelize from '../utils/db/sequelize'
import User from './User'

export interface BalanceHistoryAttributes {
  id: number
  user_id: number
  balance_usd: string
  erc20: string
  ether: string
  yearnfi: string
  timestamp: Date
}

class BalanceHistory
  extends Model<InferAttributes<BalanceHistory>, InferCreationAttributes<BalanceHistory>>
  implements BalanceHistoryAttributes
{
  declare id: CreationOptional<number>
  declare user_id: number
  declare balance_usd: string
  declare erc20: CreationOptional<string>
  declare ether: CreationOptional<string>
  declare yearnfi: CreationOptional<string>
  declare timestamp: CreationOptional<Date>

  // Static method to record balance
  static async recordBalance(
    userId: number,
    balanceUsd: string,
    etherBalance: string = 'n/a',
    yearnfiBalance: string = 'n/a',
    erc20Balance: string = 'n/a'
  ) {
    return this.create({
      user_id: userId,
      balance_usd: balanceUsd,
      ether: etherBalance,
      yearnfi: yearnfiBalance,
      erc20: erc20Balance,
      timestamp: new Date()
    })
  }

  // Static method to get balance history for a user
  static async getUserHistory(
    userId: number,
    startDate?: Date,
    endDate?: Date,
    limit?: number
  ) {
    const whereClause: any = { user_id: userId }
    
    if (startDate || endDate) {
      whereClause.timestamp = {}
      if (startDate) whereClause.timestamp[Op.gte] = startDate
      if (endDate) whereClause.timestamp[Op.lte] = endDate
    }

    return this.findAll({
      where: whereClause,
      order: [['timestamp', 'ASC']],
      limit: limit,
      raw: true
    })
  }

  // Static method to get latest balance for user
  static async getLatestBalance(userId: number) {
    return this.findOne({
      where: { user_id: userId },
      order: [['timestamp', 'DESC']],
      raw: true
    })
  }

  // Static method to bulk insert balances
  static async bulkRecordBalances(records: Array<{ user_id: number; balance_usd: string }>) {
    const timestamp = new Date()
    const balances = records.map(record => ({
      user_id: record.user_id,
      balance_usd: record.balance_usd,
      timestamp
    }))
    
    return this.bulkCreate(balances)
  }

  // Static method to get balance at specific time
  static async getBalanceAtTime(userId: number, targetDate: Date) {
    return this.findOne({
      where: {
        user_id: userId,
        timestamp: { [Op.lte]: targetDate }
      },
      order: [['timestamp', 'DESC']],
      raw: true
    })
  }

  // Static method to delete old records (for data retention)
  static async deleteOlderThan(days: number) {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)
    
    return this.destroy({
      where: {
        timestamp: { [Op.lt]: cutoffDate }
      }
    })
  }
}

BalanceHistory.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    erc20: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'n/a'
    },
    ether: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'n/a'
    },
    yearnfi: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'n/a'
    },
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    balance_usd: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    }
  },
  {
    sequelize,
    modelName: 'BalanceHistory',
    tableName: 'balance_history',
    timestamps: false,
    indexes: [
      {
        name: 'idx_user_id',
        fields: ['user_id']
      },
      {
        name: 'idx_timestamp',
        fields: ['timestamp']
      },
      {
        name: 'idx_user_timestamp',
        fields: ['user_id', 'timestamp']
      }
    ]
  }
)

// Define association
User.hasMany(BalanceHistory, { foreignKey: 'user_id', as: 'balances' })
BalanceHistory.belongsTo(User, { foreignKey: 'user_id', as: 'user' })

export default BalanceHistory