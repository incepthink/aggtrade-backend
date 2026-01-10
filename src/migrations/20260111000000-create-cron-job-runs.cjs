'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table already exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('cron_job_runs')
    );

    if (tableExists) {
      console.log('Table cron_job_runs already exists');
      return;
    }

    // Create the table
    await queryInterface.createTable('cron_job_runs', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      job_name: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Name of cron job (equity_trend_update)'
      },
      scheduled_time: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'Expected run time (rounded to 4-hour mark: 0, 4, 8, 12, 16, 20)'
      },
      started_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      status: {
        type: Sequelize.ENUM('running', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'running'
      },
      total_users: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      },
      successful_users: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      },
      skipped_users: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      },
      failed_users: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      },
      duration_ms: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        comment: 'Duration in milliseconds'
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    // Add indexes for fast lookups
    await queryInterface.addIndex('cron_job_runs', ['job_name', 'scheduled_time'], {
      name: 'idx_job_scheduled',
      unique: false
    });

    await queryInterface.addIndex('cron_job_runs', ['status'], {
      name: 'idx_status'
    });

    await queryInterface.addIndex('cron_job_runs', ['completed_at'], {
      name: 'idx_completed_at'
    });

    console.log('Created table: cron_job_runs');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('cron_job_runs');
    console.log('Dropped table: cron_job_runs');
  }
};
