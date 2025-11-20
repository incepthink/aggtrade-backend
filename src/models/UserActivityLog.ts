import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface UserActivityLogAttributes {
  id: number
  user_id: number
  platform: string
  action_category: string
  action_type: string
  tx_hash: string | null
  chain_id: number
  block_number: number | null
  block_timestamp: Date | null
  usd_volume: number
  pool_id: string | null
  token_address: string | null
  token_symbol: string | null
  status: string
  metadata: any
  timestamp: Date
  created_at?: Date
  updated_at?: Date
}

class UserActivityLog
  extends Model<InferAttributes<UserActivityLog>, InferCreationAttributes<UserActivityLog>>
  implements UserActivityLogAttributes
{
  declare id: CreationOptional<number>
  declare user_id: number
  declare platform: string
  declare action_category: string
  declare action_type: string
  declare tx_hash: string | null
  declare chain_id: number
  declare block_number: number | null
  declare block_timestamp: Date | null
  declare usd_volume: number
  declare pool_id: string | null
  declare token_address: string | null
  declare token_symbol: string | null
  declare status: string
  declare metadata: any
  declare timestamp: Date
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Static method to get user activity feed
  static async getUserActivity(
    userId: number,
    limit: number = 50,
    offset: number = 0
  ) {
    return this.findAll({
      attributes: [
        'timestamp',
        'platform',
        'action_category',
        'action_type',
        'token_symbol',
        'usd_volume',
        'status',
        'tx_hash'
      ],
      where: {
        user_id: userId
      },
      order: [['timestamp', 'DESC']],
      limit,
      offset,
      raw: true
    })
  }

  // Static method to calculate user total volume
  static async getUserTotalVolume(
    userId: number,
    startDate?: Date,
    endDate?: Date
  ) {
    const whereClause: any = {
      user_id: userId,
      status: 'success'
    }

    if (startDate && endDate) {
      whereClause.timestamp = {
        [Op.between]: [startDate, endDate]
      }
    }

    const result = await this.findOne({
      attributes: [
        [sequelize.fn('SUM', sequelize.col('usd_volume')), 'total_volume']
      ],
      where: whereClause,
      raw: true
    })

    return result ? (result as any).total_volume || 0 : 0
  }

  // Static method to get platform statistics
  static async getPlatformStats(
    platform: string,
    startDate: Date,
    endDate: Date
  ) {
    return this.findAll({
      attributes: [
        'action_type',
        [sequelize.fn('COUNT', sequelize.col('id')), 'tx_count'],
        [sequelize.fn('SUM', sequelize.col('usd_volume')), 'total_volume']
      ],
      where: {
        platform,
        timestamp: {
          [Op.between]: [startDate, endDate]
        }
      },
      group: ['action_type'],
      raw: true
    })
  }

  // Static method to get leaderboard
  static async getLeaderboard(
    actionCategory: string,
    startDate: Date,
    endDate: Date,
    limit: number = 100
  ) {
    return this.findAll({
      attributes: [
        'user_id',
        [sequelize.fn('SUM', sequelize.col('usd_volume')), 'total_volume']
      ],
      where: {
        action_category: actionCategory,
        status: 'success',
        timestamp: {
          [Op.between]: [startDate, endDate]
        }
      },
      group: ['user_id'],
      order: [[sequelize.literal('total_volume'), 'DESC']],
      limit,
      raw: true
    })
  }

  // Static method to get token activity
  static async getTokenActivity(
    tokenAddress: string,
    startDate: Date,
    endDate: Date
  ) {
    return this.findAll({
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'swap_count'],
        [sequelize.fn('AVG', sequelize.col('usd_volume')), 'avg_volume'],
        [sequelize.fn('SUM', sequelize.col('usd_volume')), 'total_volume']
      ],
      where: {
        token_address: tokenAddress.toLowerCase(),
        action_category: 'swap',
        timestamp: {
          [Op.between]: [startDate, endDate]
        }
      },
      raw: true
    })
  }

  // Static method to check if transaction exists
  static async transactionExists(txHash: string, chainId: number) {
    const count = await this.count({
      where: {
        tx_hash: txHash,
        chain_id: chainId
      }
    })
    return count > 0
  }

  // Static method to get failed transactions
  static async getFailedTransactions(startDate: Date, endDate: Date) {
    return this.findAll({
      attributes: [
        'user_id',
        'tx_hash',
        'action_type',
        'timestamp',
        'status'
      ],
      where: {
        status: {
          [Op.in]: ['failed', 'reverted']
        },
        timestamp: {
          [Op.between]: [startDate, endDate]
        }
      },
      order: [['timestamp', 'DESC']],
      raw: true
    })
  }

  // Static method to get user activity by category
  static async getUserActivityByCategory(
    userId: number,
    actionCategory: string,
    startDate?: Date,
    endDate?: Date
  ) {
    const whereClause: any = {
      user_id: userId,
      action_category: actionCategory,
      status: 'success'
    }

    if (startDate && endDate) {
      whereClause.timestamp = {
        [Op.between]: [startDate, endDate]
      }
    }

    return this.findAll({
      where: whereClause,
      order: [['timestamp', 'DESC']],
      raw: true
    })
  }
}

UserActivityLog.init(
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
    platform: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    action_category: {
      type: DataTypes.STRING(20),
      allowNull: false
    },
    action_type: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    tx_hash: {
      type: DataTypes.STRING(66),
      allowNull: true
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
    usd_volume: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: 0
    },
    pool_id: {
      type: DataTypes.STRING(42),
      allowNull: true
    },
    token_address: {
      type: DataTypes.STRING(42),
      allowNull: true
    },
    token_symbol: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'success'
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true
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
    modelName: 'UserActivityLog',
    tableName: 'user_activity_log',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      // UNIQUE INDEX: Transaction hash deduplication
      {
        name: 'idx_tx_hash_unique',
        fields: ['tx_hash'],
        unique: true
      },
      // PRIMARY INDEX: User + Time (DESC) - Critical for user activity queries
      {
        name: 'idx_user_timestamp',
        fields: [
          'user_id',
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // COVERING INDEX: Include volume and category for index-only scans
      {
        name: 'idx_user_timestamp_covering',
        fields: [
          'user_id',
          { name: 'timestamp', order: 'DESC' },
          'usd_volume',
          'action_category'
        ]
      },
      // Category-based queries for leaderboards
      {
        name: 'idx_action_category_timestamp',
        fields: [
          'action_category',
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // Platform analytics
      {
        name: 'idx_platform_timestamp',
        fields: [
          'platform',
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // Leaderboard queries with time bounds
      {
        name: 'idx_leaderboard',
        fields: [
          { name: 'timestamp', order: 'DESC' },
          { name: 'usd_volume', order: 'DESC' }
        ]
      },
      // Multi-chain queries
      {
        name: 'idx_chain_timestamp',
        fields: [
          'chain_id',
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // Token activity tracking
      {
        name: 'idx_token_timestamp',
        fields: [
          'token_address',
          { name: 'timestamp', order: 'DESC' }
        ]
      },
      // Data sync queries
      {
        name: 'idx_created_at',
        fields: ['created_at']
      },
      // Status filtering
      {
        name: 'idx_status',
        fields: ['status']
      }
    ]
  }
)

export default UserActivityLog