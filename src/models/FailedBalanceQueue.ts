import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface FailedBalanceQueueAttributes {
  id: number
  user_id: number
  wallet_address: string
  cron_run_id: number | null
  failed_at: Date
  failure_reason: string | null
  retry_count: number
  max_retries: number
  status: 'pending' | 'retrying' | 'success' | 'abandoned'
  resolved_at: Date | null
}

class FailedBalanceQueue
  extends Model<InferAttributes<FailedBalanceQueue>, InferCreationAttributes<FailedBalanceQueue>>
  implements FailedBalanceQueueAttributes
{
  declare id: CreationOptional<number>
  declare user_id: number
  declare wallet_address: string
  declare cron_run_id: number | null
  declare failed_at: Date
  declare failure_reason: string | null
  declare retry_count: number
  declare max_retries: number
  declare status: 'pending' | 'retrying' | 'success' | 'abandoned'
  declare resolved_at: Date | null

  // Add user to retry queue
  static async addToQueue(
    userId: number,
    walletAddress: string,
    cronRunId: number | null,
    reason: string | null
  ) {
    // Check if already in queue
    const existing = await this.findOne({
      where: {
        user_id: userId,
        status: { [Op.in]: ['pending', 'retrying'] }
      }
    })

    if (existing) {
      // Just increment retry count
      return existing.update({
        retry_count: existing.retry_count + 1,
        failure_reason: reason,
        cron_run_id: cronRunId
      })
    }

    return this.create({
      user_id: userId,
      wallet_address: walletAddress,
      cron_run_id: cronRunId,
      failed_at: new Date(),
      failure_reason: reason,
      retry_count: 0,
      max_retries: 3,
      status: 'pending'
    })
  }

  // Get users ready for retry
  static async getRetriableUsers() {
    return this.findAll({
      where: {
        status: 'pending',
        retry_count: { [Op.lt]: sequelize.col('max_retries') }
      },
      limit: 100, // Limit retries per run
      order: [['failed_at', 'ASC']],
      raw: true
    })
  }

  // Update status to retrying
  static async markRetrying(queueId: number) {
    return this.update({ status: 'retrying' }, { where: { id: queueId } })
  }

  // Mark as successful
  static async markSuccess(queueId: number) {
    return this.update(
      { status: 'success', resolved_at: new Date() },
      { where: { id: queueId } }
    )
  }

  // Mark as abandoned (max retries exceeded)
  static async markAbandoned(queueId: number) {
    return this.update(
      { status: 'abandoned', resolved_at: new Date() },
      { where: { id: queueId } }
    )
  }

  // Increment retry count
  static async incrementRetry(queueId: number) {
    return this.increment('retry_count', { where: { id: queueId }, by: 1 })
      .then(() => this.update({ status: 'pending' }, { where: { id: queueId } }))
  }

  // Get queue statistics
  static async getQueueStats() {
    const pending = await this.count({ where: { status: 'pending' } })
    const retrying = await this.count({ where: { status: 'retrying' } })
    const abandoned = await this.count({ where: { status: 'abandoned' } })

    return { pending, retrying, abandoned }
  }
}

FailedBalanceQueue.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false
    },
    cron_run_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true
    },
    failed_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    failure_reason: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    retry_count: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    max_retries: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 3
    },
    status: {
      type: DataTypes.ENUM('pending', 'retrying', 'success', 'abandoned'),
      allowNull: false,
      defaultValue: 'pending'
    },
    resolved_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  },
  {
    sequelize,
    modelName: 'FailedBalanceQueue',
    tableName: 'failed_balance_queue',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
)

export default FailedBalanceQueue
