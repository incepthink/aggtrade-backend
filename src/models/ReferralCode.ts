import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface ReferralCodeAttributes {
  id: number
  user_id: number
  code: string
  total_referrals: number
  total_volume: string
  total_rewards: string
  claimed_rewards: string
  is_active: boolean
  created_at?: Date
  updated_at?: Date
}

class ReferralCode
  extends Model<InferAttributes<ReferralCode>, InferCreationAttributes<ReferralCode>>
  implements ReferralCodeAttributes
{
  declare id: CreationOptional<number>
  declare user_id: number
  declare code: string
  declare total_referrals: CreationOptional<number>
  declare total_volume: CreationOptional<string>
  declare total_rewards: CreationOptional<string>
  declare claimed_rewards: CreationOptional<string>
  declare is_active: CreationOptional<boolean>
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Generate unique code (8 letters + 4 numbers)
  static async generateUniqueCode(): Promise<string> {
    let code: string
    let exists = true

    while (exists) {
      const letters = Array.from({ length: 8 }, () => 
        String.fromCharCode(65 + Math.floor(Math.random() * 26))
      ).join('')
      
      const numbers = Array.from({ length: 4 }, () => 
        Math.floor(Math.random() * 10)
      ).join('')
      
      code = letters + numbers

      const existing = await this.findOne({ where: { code } })
      exists = existing !== null
    }

    return code!
  }

  // Find by code
  static async findByCode(code: string) {
    return this.findOne({
      where: {
        code: code.toUpperCase(),
        is_active: true
      }
    })
  }

  // Find by user ID
  static async findByUserId(userId: number) {
    return this.findOne({
      where: {
        user_id: userId
      }
    })
  }

  // Create code for user
  static async createForUser(userId: number) {
    const existing = await this.findByUserId(userId)
    if (existing) {
      throw new Error('User already has a referral code')
    }

    const code = await this.generateUniqueCode()

    return this.create({
      user_id: userId,
      code
    })
  }

  // Get available rewards (not yet claimed)
  getAvailableRewards(): number {
    return parseFloat(this.total_rewards) - parseFloat(this.claimed_rewards)
  }
}

ReferralCode.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      unique: true
    },
    code: {
      type: DataTypes.STRING(12),
      allowNull: false,
      unique: true
    },
    total_referrals: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    total_volume: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: '0.000000'
    },
    total_rewards: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: '0.000000'
    },
    claimed_rewards: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: '0.000000'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
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
    modelName: 'ReferralCode',
    tableName: 'referral_codes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_referral_codes_code',
        fields: ['code'],
        unique: true
      },
      {
        name: 'idx_referral_codes_user_id',
        fields: ['user_id'],
        unique: true
      }
    ]
  }
)

export default ReferralCode