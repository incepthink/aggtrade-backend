import User from './User'
import ReferralCode from './ReferralCode'
import Referral from './Referral'
import KatanaSwap from "./KatanaSwap"
import BotWalletExecution from './BotWalletExecution'
import BotLimitOrder from './BotLimitOrder'
import BotWallet from './BotWallet'
import BotOrdersSimple from './BotOrdersSimple'

const defineAssociations = () => {
  // BotWalletExecution <-> BotLimitOrder (one-to-many)
  BotWalletExecution.hasMany(BotLimitOrder, {
    foreignKey: 'execution_id',
    sourceKey: 'execution_id',
    as: 'orders'
  })
  BotLimitOrder.belongsTo(BotWalletExecution, {
    foreignKey: 'execution_id',
    targetKey: 'execution_id',
    as: 'walletExecution'
  })


  // User <-> ReferralCode (one-to-one)
  User.hasOne(ReferralCode, {
    foreignKey: 'user_id',
    as: 'referralCode'
  })
  ReferralCode.belongsTo(User, {
    foreignKey: 'user_id',
    as: 'user'
  })

  // User <-> Referral (one-to-many as referrer)
  User.hasMany(Referral, {
    foreignKey: 'referrer_user_id',
    as: 'referrals'
  })
  Referral.belongsTo(User, {
    foreignKey: 'referrer_user_id',
    as: 'referrer'
  })

  // User <-> Referral (one-to-one as referred user)
  User.hasOne(Referral, {
    foreignKey: 'referred_user_id',
    as: 'referredBy'
  })
  Referral.belongsTo(User, {
    foreignKey: 'referred_user_id',
    as: 'referredUser'
  })
}

defineAssociations()

export { User, ReferralCode, Referral, KatanaSwap, BotWalletExecution, BotLimitOrder, BotWallet, BotOrdersSimple }