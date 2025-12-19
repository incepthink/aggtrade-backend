import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

/**
 * XP Distribution Model
 *
 * Stores weekly XP calculations per wallet address
 * Optimized for:
 * - Fast lookups by wallet and week
 * - Leaderboard queries
 * - Historical XP tracking
 */
export interface XpDistributionAttributes {
  id: number
  wallet_address: string
  user_id: number | null
  week_start: Date
  week_end: Date
  league: 'bronze' | 'silver' | 'gold' | 'diamond'
  swap_xp_raw: number
  swap_xp_decayed: number
  pair_bonus_xp: number
  total_xp: number
  eligible_volume: number
  total_fees: number
  unique_pairs_count: number
  new_pairs_count: number
  total_swaps: number
  metadata: any
  calculated_at: Date
  created_at?: Date
  updated_at?: Date
}

class XpDistribution
  extends Model<InferAttributes<XpDistribution>, InferCreationAttributes<XpDistribution>>
  implements XpDistributionAttributes
{
  declare id: CreationOptional<number>
  declare wallet_address: string
  declare user_id: number | null
  declare week_start: Date
  declare week_end: Date
  declare league: 'bronze' | 'silver' | 'gold' | 'diamond'
  declare swap_xp_raw: number
  declare swap_xp_decayed: number
  declare pair_bonus_xp: number
  declare total_xp: number
  declare eligible_volume: number
  declare total_fees: number
  declare unique_pairs_count: number
  declare new_pairs_count: number
  declare total_swaps: number
  declare metadata: any
  declare calculated_at: Date
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>
}

XpDistribution.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false,
      comment: 'User wallet address (lowercase)'
    },
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      },
      onDelete: 'SET NULL',
      comment: 'Associated user ID (nullable for wallets without users)'
    },
    week_start: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Start of the XP calculation week'
    },
    week_end: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'End of the XP calculation week'
    },
    league: {
      type: DataTypes.ENUM('bronze', 'silver', 'gold', 'diamond'),
      allowNull: false,
      comment: 'League tier based on eligible volume'
    },
    swap_xp_raw: {
      type: DataTypes.DECIMAL(20, 4),
      allowNull: false,
      defaultValue: 0,
      comment: 'Total XP from swaps before band decay'
    },
    swap_xp_decayed: {
      type: DataTypes.DECIMAL(20, 4),
      allowNull: false,
      defaultValue: 0,
      comment: 'Total XP from swaps after band decay'
    },
    pair_bonus_xp: {
      type: DataTypes.DECIMAL(20, 4),
      allowNull: false,
      defaultValue: 0,
      comment: 'XP bonus from unique pair trading (25 XP per new pair, max 4)'
    },
    total_xp: {
      type: DataTypes.DECIMAL(20, 4),
      allowNull: false,
      defaultValue: 0,
      comment: 'Final total XP (swap_xp_decayed + pair_bonus_xp)'
    },
    eligible_volume: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: 0,
      comment: 'Total eligible USD volume after filtering'
    },
    total_fees: {
      type: DataTypes.DECIMAL(20, 8),
      allowNull: false,
      defaultValue: 0,
      comment: 'Total fees paid in USD'
    },
    unique_pairs_count: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
      comment: 'Number of unique trading pairs'
    },
    new_pairs_count: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
      comment: 'Number of first-time trading pairs'
    },
    total_swaps: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
      comment: 'Total number of swaps processed'
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Detailed breakdown: per-pair XP, fee updates, etc.'
    },
    calculated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'When this XP calculation was performed'
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
    modelName: 'XpDistribution',
    tableName: 'xp_distributions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        // Unique constraint: one XP record per wallet per week
        name: 'idx_wallet_week_unique',
        fields: ['wallet_address', 'week_start'],
        unique: true
      },
      {
        // Fast lookups by wallet (user history)
        name: 'idx_wallet_address',
        fields: ['wallet_address']
      },
      {
        // Fast lookups by week (weekly reports)
        name: 'idx_week_start',
        fields: [{ name: 'week_start', order: 'DESC' }]
      },
      {
        // Leaderboard queries (highest XP first)
        name: 'idx_total_xp',
        fields: [{ name: 'total_xp', order: 'DESC' }]
      },
      {
        // Leaderboard queries per week
        name: 'idx_week_total_xp',
        fields: ['week_start', { name: 'total_xp', order: 'DESC' }]
      },
      {
        // User-specific queries
        name: 'idx_user_id',
        fields: ['user_id']
      },
      {
        // League-based queries
        name: 'idx_league',
        fields: ['league']
      }
    ]
  }
)

export default XpDistribution
