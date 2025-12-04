import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface BotOrdersSimpleAttributes {
  id: number
  wallet_address: string
  blockchain_order_id: string
  order_type: 'grid_buy' | 'grid_sell' | 'counter_buy' | 'counter_sell'
  parent_order_id: number | null
  from_token: string
  to_token: string
  from_amount: string
  to_amount: string
  status: 'pending' | 'partial' | 'filled' | 'expired' | 'canceled'
  progress: number
  placed_at: Date
  filled_at: Date | null
  last_checked_at: Date | null
  usd_value: string | null
  created_at?: Date
  updated_at?: Date
}

class BotOrdersSimple
  extends Model<InferAttributes<BotOrdersSimple>, InferCreationAttributes<BotOrdersSimple>>
  implements BotOrdersSimpleAttributes
{
  declare id: CreationOptional<number>
  declare wallet_address: string
  declare blockchain_order_id: string
  declare order_type: 'grid_buy' | 'grid_sell' | 'counter_buy' | 'counter_sell'
  declare parent_order_id: number | null
  declare from_token: string
  declare to_token: string
  declare from_amount: string
  declare to_amount: string
  declare status: 'pending' | 'partial' | 'filled' | 'expired' | 'canceled'
  declare progress: number
  declare placed_at: Date
  declare filled_at: Date | null
  declare last_checked_at: Date | null
  declare usd_value: string | null
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Static method to find order by blockchain ID
  static async findByBlockchainId(blockchainOrderId: string) {
    return this.findOne({
      where: {
        blockchain_order_id: blockchainOrderId
      }
    })
  }

  // Static method to find orders by wallet address
  static async findByWallet(walletAddress: string) {
    return this.findAll({
      where: {
        wallet_address: walletAddress.toLowerCase()
      },
      order: [['placed_at', 'DESC']]
    })
  }

  // Static method to find grid orders (parent orders)
  static async findGridOrders(walletAddress?: string) {
    const where: any = {
      order_type: ['grid_buy', 'grid_sell']
    }

    if (walletAddress) {
      where.wallet_address = walletAddress.toLowerCase()
    }

    return this.findAll({
      where,
      order: [['placed_at', 'DESC']]
    })
  }

  // Static method to find counter orders for a parent order
  static async findCounterOrders(parentOrderId: number) {
    return this.findAll({
      where: {
        parent_order_id: parentOrderId
      },
      order: [['placed_at', 'DESC']]
    })
  }

  // Static method to find orders by status
  static async findByStatus(status: 'pending' | 'partial' | 'filled' | 'expired' | 'canceled', walletAddress?: string) {
    const where: any = { status }

    if (walletAddress) {
      where.wallet_address = walletAddress.toLowerCase()
    }

    return this.findAll({
      where,
      order: [['placed_at', 'DESC']]
    })
  }

  // Static method to find active orders (pending or partial)
  static async findActiveOrders(walletAddress?: string) {
    const where: any = {
      status: ['pending', 'partial']
    }

    if (walletAddress) {
      where.wallet_address = walletAddress.toLowerCase()
    }

    return this.findAll({
      where,
      order: [['placed_at', 'DESC']]
    })
  }

  // Static method to update order status
  static async updateOrderStatus(
    blockchainOrderId: string,
    status: 'pending' | 'partial' | 'filled' | 'expired' | 'canceled',
    progress: number,
    filledAt?: Date
  ) {
    const updateData: any = {
      status,
      progress,
      last_checked_at: new Date()
    }

    if (filledAt) {
      updateData.filled_at = filledAt
    }

    return this.update(
      updateData,
      {
        where: {
          blockchain_order_id: blockchainOrderId
        }
      }
    )
  }

  // Static method to bulk update last checked timestamp
  static async updateLastChecked(blockchainOrderIds: string[]) {
    return this.update(
      { last_checked_at: new Date() },
      {
        where: {
          blockchain_order_id: blockchainOrderIds
        }
      }
    )
  }

  // Static method to get orders that need checking (not checked recently)
  static async getOrdersNeedingCheck(minutesThreshold: number = 5) {
    const thresholdDate = new Date(Date.now() - minutesThreshold * 60 * 1000)

    return this.findAll({
      where: {
        status: ['pending', 'partial'],
        last_checked_at: {
          [Op.or]: [
            { [Op.lt]: thresholdDate },
            { [Op.is]: null }
          ]
        }
      },
      order: [['last_checked_at', 'ASC']]
    })
  }

  // Static method to cancel order
  static async cancelOrder(blockchainOrderId: string) {
    return this.update(
      {
        status: 'canceled',
        last_checked_at: new Date()
      },
      {
        where: {
          blockchain_order_id: blockchainOrderId
        }
      }
    )
  }

  // Static method to get order statistics for a wallet
  static async getWalletStats(walletAddress: string) {
    const orders = await this.findByWallet(walletAddress)

    const stats = {
      total: orders.length,
      pending: 0,
      partial: 0,
      filled: 0,
      expired: 0,
      canceled: 0,
      totalUsdValue: 0
    }

    orders.forEach(order => {
      stats[order.status]++
      if (order.usd_value) {
        stats.totalUsdValue += parseFloat(order.usd_value)
      }
    })

    return stats
  }
}

BotOrdersSimple.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false,
      validate: {
        is: /^0x[a-fA-F0-9]{40}$/
      },
      comment: 'Wallet address that owns this order'
    },
    blockchain_order_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      comment: 'Actual order ID from blockchain contract'
    },
    order_type: {
      type: DataTypes.ENUM('grid_buy', 'grid_sell', 'counter_buy', 'counter_sell'),
      allowNull: false,
      comment: 'Type of order in the grid trading system'
    },
    parent_order_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      comment: 'Null for grid orders, points to parent order for counter-orders'
    },
    from_token: {
      type: DataTypes.STRING(20),
      allowNull: false,
      comment: 'Token symbol being sold (e.g., ETH, USDC)'
    },
    to_token: {
      type: DataTypes.STRING(20),
      allowNull: false,
      comment: 'Token symbol being bought (e.g., USDC, ETH)'
    },
    from_amount: {
      type: DataTypes.STRING(78),
      allowNull: false,
      comment: 'Amount of from_token being sold as string to handle large numbers'
    },
    to_amount: {
      type: DataTypes.STRING(78),
      allowNull: false,
      comment: 'Amount of to_token expected to receive as string to handle large numbers'
    },
    status: {
      type: DataTypes.ENUM('pending', 'partial', 'filled', 'expired', 'canceled'),
      allowNull: false,
      defaultValue: 'pending',
      comment: 'Current status of the order'
    },
    progress: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0,
      validate: {
        min: 0,
        max: 100
      },
      comment: 'Percentage filled (0-100)'
    },
    placed_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'When the order was created'
    },
    filled_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'When the order was completed, null if not filled yet'
    },
    last_checked_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'When we last polled blockchain for this order'
    },
    usd_value: {
      type: DataTypes.STRING(78),
      allowNull: true,
      comment: 'Approximate USD value of the trade as string to handle large numbers'
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
    modelName: 'BotOrdersSimple',
    tableName: 'bot_orders_simple',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_blockchain_order_id_unique',
        fields: ['blockchain_order_id'],
        unique: true
      },
      {
        name: 'idx_wallet_address',
        fields: ['wallet_address']
      },
      {
        name: 'idx_order_type',
        fields: ['order_type']
      },
      {
        name: 'idx_parent_order_id',
        fields: ['parent_order_id']
      },
      {
        name: 'idx_status',
        fields: ['status']
      },
      {
        name: 'idx_wallet_status',
        fields: ['wallet_address', 'status']
      },
      {
        name: 'idx_placed_at',
        fields: ['placed_at']
      },
      {
        name: 'idx_last_checked_at',
        fields: ['last_checked_at']
      },
      {
        name: 'idx_active_orders',
        fields: ['status', 'last_checked_at'],
        where: {
          status: ['pending', 'partial']
        }
      }
    ]
  }
)

export default BotOrdersSimple