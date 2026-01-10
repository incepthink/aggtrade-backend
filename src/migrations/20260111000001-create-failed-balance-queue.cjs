'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table already exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('failed_balance_queue')
    );

    if (tableExists) {
      console.log('Table failed_balance_queue already exists');
      return;
    }

    // Create the table
    await queryInterface.createTable('failed_balance_queue', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      wallet_address: {
        type: Sequelize.STRING(42),
        allowNull: false
      },
      cron_run_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: {
          model: 'cron_job_runs',
          key: 'id'
        },
        onDelete: 'SET NULL'
      },
      failed_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      failure_reason: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      retry_count: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      },
      max_retries: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 3
      },
      status: {
        type: Sequelize.ENUM('pending', 'retrying', 'success', 'abandoned'),
        allowNull: false,
        defaultValue: 'pending'
      },
      resolved_at: {
        type: Sequelize.DATE,
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

    // Add indexes
    await queryInterface.addIndex('failed_balance_queue', ['user_id'], {
      name: 'idx_user_id'
    });

    await queryInterface.addIndex('failed_balance_queue', ['status'], {
      name: 'idx_status'
    });

    await queryInterface.addIndex('failed_balance_queue', ['wallet_address'], {
      name: 'idx_wallet_address'
    });

    // Composite index for retry queries
    await queryInterface.addIndex('failed_balance_queue', ['status', 'retry_count'], {
      name: 'idx_status_retry'
    });

    console.log('Created table: failed_balance_queue');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('failed_balance_queue');
    console.log('Dropped table: failed_balance_queue');
  }
};
