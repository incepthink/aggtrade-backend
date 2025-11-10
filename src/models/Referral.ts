import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface ReferralAttributes {
  id: number
  referrer_user_id: number
  referred_user_id: number
  code: string
  volume_traded: string
  rewards_generated: string
  is_active: boolean
  referred_at: Date
  created_at?: Date
  updated_at?: Date
}

class Referral
  extends Model<InferAttributes<Referral>, InferCreationAttributes<Referral>>
  implements ReferralAttributes
{
  declare id: CreationOptional<number>
  declare referrer_user_id: number
  declare referred_user_id: number
  declare code: string
  declare volume_traded: CreationOptional<string>
  declare rewards_generated: CreationOptional<string>
  declare is_active: CreationOptional<boolean>
  declare referred_at: CreationOptional<Date>
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Find by referred user ID
  static async findByReferredUser(userId: number) {
    return this.findOne({
      where: {
        referred_user_id: userId
      }
    })
  }

  // Get all referrals for a referrer
  static async findByReferrer(referrerUserId: number) {
    return this.findAll({
      where: {
        referrer_user_id: referrerUserId
      },
      order: [['referred_at', 'DESC']]
    })
  }

  // Check if user has used a referral code
  static async hasUsedCode(userId: number): Promise<boolean> {
    const referral = await this.findByReferredUser(userId)
    return referral !== null
  }
}

Referral.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    referrer_user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false
    },
    referred_user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      unique: true
    },
    code: {
      type: DataTypes.STRING(12),
      allowNull: false
    },
    volume_traded: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: '0.000000'
    },
    rewards_generated: {
      type: DataTypes.DECIMAL(30, 6),
      allowNull: false,
      defaultValue: '0.000000'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    referred_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
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
    modelName: 'Referral',
    tableName: 'referrals',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_referrals_referred_user',
        fields: ['referred_user_id'],
        unique: true
      },
      {
        name: 'idx_referrals_referrer_user',
        fields: ['referrer_user_id']
      },
      {
        name: 'idx_referrals_code',
        fields: ['code']
      }
    ]
  }
)

export default Referral