import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  Op
} from 'sequelize'
import sequelize from '../utils/db/sequelize'

export interface CronJobRunAttributes {
  id: number
  job_name: string
  scheduled_time: Date
  started_at: Date
  completed_at: Date | null
  status: 'running' | 'completed' | 'failed'
  total_users: number
  successful_users: number
  skipped_users: number
  failed_users: number
  duration_ms: number | null
  error_message: string | null
}

class CronJobRun
  extends Model<InferAttributes<CronJobRun>, InferCreationAttributes<CronJobRun>>
  implements CronJobRunAttributes
{
  declare id: CreationOptional<number>
  declare job_name: string
  declare scheduled_time: Date
  declare started_at: Date
  declare completed_at: Date | null
  declare status: 'running' | 'completed' | 'failed'
  declare total_users: number
  declare successful_users: number
  declare skipped_users: number
  declare failed_users: number
  declare duration_ms: number | null
  declare error_message: string | null

  // Create new cron run record
  static async createRun(jobName: string, scheduledTime: Date, totalUsers: number) {
    return this.create({
      job_name: jobName,
      scheduled_time: scheduledTime,
      started_at: new Date(),
      status: 'running',
      total_users: totalUsers,
      successful_users: 0,
      skipped_users: 0,
      failed_users: 0
    })
  }

  // Update run with final stats
  static async updateRunStatus(
    runId: number,
    status: 'completed' | 'failed',
    stats: {
      successful_users?: number
      skipped_users?: number
      failed_users?: number
      duration_ms?: number
      error_message?: string
    }
  ) {
    return this.update(
      {
        status,
        completed_at: new Date(),
        ...stats
      },
      { where: { id: runId } }
    )
  }

  // Get last completed run
  static async getLastRun(jobName: string) {
    return this.findOne({
      where: { job_name: jobName, status: 'completed' },
      order: [['completed_at', 'DESC']],
      raw: true
    })
  }

  // Detect missed runs (gaps in 4-hour schedule)
  static async detectMissedRuns(jobName: string, lookbackHours: number = 24) {
    const now = new Date()
    const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000)

    const runs = await this.findAll({
      where: {
        job_name: jobName,
        scheduled_time: { [Op.gte]: since }
      },
      order: [['scheduled_time', 'ASC']],
      raw: true
    })

    // Generate expected run times (every 4 hours)
    const expectedTimes = this.generateExpectedRunTimes(since, now, 4)

    // Find missing runs (tolerance: 10 minutes)
    const missedRuns = expectedTimes.filter(expected =>
      !runs.some(run =>
        Math.abs(new Date(run.scheduled_time).getTime() - expected.getTime()) < 10 * 60 * 1000
      )
    )

    return missedRuns
  }

  // Helper: Generate expected 4-hour run times
  private static generateExpectedRunTimes(start: Date, end: Date, intervalHours: number): Date[] {
    const times = []
    let current = new Date(start)

    // Round to nearest interval
    current.setMinutes(0, 0, 0)
    current.setHours(Math.floor(current.getHours() / intervalHours) * intervalHours)

    while (current <= end) {
      times.push(new Date(current))
      current.setHours(current.getHours() + intervalHours)
    }

    return times
  }
}

CronJobRun.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true
    },
    job_name: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    scheduled_time: {
      type: DataTypes.DATE,
      allowNull: false
    },
    started_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('running', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'running'
    },
    total_users: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    successful_users: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    skipped_users: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    failed_users: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    duration_ms: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  },
  {
    sequelize,
    modelName: 'CronJobRun',
    tableName: 'cron_job_runs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
)

export default CronJobRun
