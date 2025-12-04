import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface BotWalletAttributes {
  id: number
  wallet_address: string
  wallet_index: number
  usdc: string
  eth: string
  weth: string
  sushi: string
  placed_initial_orders: number
  trading_pool: string
  created_at?: Date
  updated_at?: Date
}

class BotWallet
  extends Model<InferAttributes<BotWallet>, InferCreationAttributes<BotWallet>>
  implements BotWalletAttributes
{
  declare id: CreationOptional<number>
  declare wallet_address: string
  declare wallet_index: number
  declare usdc: string
  declare eth: string
  declare weth: string
  declare sushi: string
  declare placed_initial_orders: number
  declare trading_pool: string
  declare created_at: CreationOptional<Date>
  declare updated_at: CreationOptional<Date>

  // Static method to find wallet by address
  static async findByAddress(walletAddress: string) {
    return this.findOne({
      where: {
        wallet_address: walletAddress.toLowerCase()
      }
    })
  }

  // Static method to find wallet by index
  static async findByIndex(walletIndex: number) {
    return this.findOne({
      where: {
        wallet_index: walletIndex
      }
    })
  }

  // Static method to get all bot wallets
  static async getAllWallets() {
    return this.findAll({
      order: [['wallet_index', 'ASC']],
      raw: true
    })
  }

  // Static method to update token balance
  static async updateTokenBalance(
    walletAddress: string,
    tokenSymbol: 'usdc' | 'eth' | 'weth' | 'sushi' | string,
    balance: string
  ) {
    return this.update(
      { [tokenSymbol]: balance },
      {
        where: {
          wallet_address: walletAddress.toLowerCase()
        }
      }
    )
  }

  // Static method to update multiple token balances at once
  static async updateMultipleBalances(
    walletAddress: string,
    balances: Partial<{ usdc: string; eth: string; weth: string; sushi: string }>
  ) {
    return this.update(
      balances,
      {
        where: {
          wallet_address: walletAddress.toLowerCase()
        }
      }
    )
  }

  // Static method to get wallet balances
  static async getBalances(walletAddress: string) {
    const wallet = await this.findByAddress(walletAddress)
    if (!wallet) {
      return null
    }
    return {
      usdc: wallet.usdc,
      eth: wallet.eth,
      weth: wallet.weth,
      sushi: wallet.sushi
    }
  }

  // Static method to create or get wallet
  static async findOrCreateWallet(walletAddress: string, walletIndex: number) {
    const [wallet, created] = await this.findOrCreate({
      where: {
        wallet_address: walletAddress.toLowerCase()
      },
      defaults: {
        wallet_address: walletAddress.toLowerCase(),
        wallet_index: walletIndex,
        usdc: '0',
        eth: '0',
        weth: '0',
        sushi: '0',
        placed_initial_orders: 0,
        trading_pool: ''
      }
    })

    return { wallet, created }
  }
}

BotWallet.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false,
      unique: true,
      validate: {
        is: /^0x[a-fA-F0-9]{40}$/
      }
    },
    wallet_index: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
      unique: true,
      validate: {
        min: 1,
        max: 100
      }
    },
    usdc: {
      type: DataTypes.STRING(78),
      allowNull: false,
      defaultValue: '0',
      comment: 'USDC token balance as string to handle large numbers'
    },
    eth: {
      type: DataTypes.STRING(78),
      allowNull: false,
      defaultValue: '0',
      comment: 'ETH token balance as string to handle large numbers'
    },
    weth: {
      type: DataTypes.STRING(78),
      allowNull: false,
      defaultValue: '0',
      comment: 'WETH token balance as string to handle large numbers'
    },
    sushi: {
      type: DataTypes.STRING(78),
      allowNull: false,
      defaultValue: '0',
      comment: 'SUSHI token balance as string to handle large numbers'
    },
    placed_initial_orders: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Number of initial orders placed'
    },
    trading_pool: {
      type: DataTypes.STRING(42),
      allowNull: false,
      defaultValue: '',
      comment: 'Trading pool address for this wallet'
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
    modelName: 'BotWallet',
    tableName: 'bot_wallets',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        name: 'idx_wallet_address_unique',
        fields: ['wallet_address'],
        unique: true
      },
      {
        name: 'idx_wallet_index_unique',
        fields: ['wallet_index'],
        unique: true
      }
    ]
  }
)

export default BotWallet