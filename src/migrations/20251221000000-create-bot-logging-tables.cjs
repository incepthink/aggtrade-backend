'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create bot_error_logs table
    await queryInterface.createTable('bot_error_logs', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      wallet_index: {
        type: Sequelize.INTEGER,
        allowNull: false
      },
      wallet_address: {
        type: Sequelize.STRING(42),
        allowNull: false
      },
      error_type: {
        type: Sequelize.STRING(50),
        allowNull: false
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      phase: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      additional_data: {
        type: Sequelize.JSON,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // Add indexes for bot_error_logs
    await queryInterface.addIndex('bot_error_logs', ['wallet_index'], {
      name: 'idx_wallet'
    });
    await queryInterface.addIndex('bot_error_logs', ['error_type'], {
      name: 'idx_type'
    });
    await queryInterface.addIndex('bot_error_logs', ['created_at'], {
      name: 'idx_created'
    });

    // Create bot_wallet_metrics table
    await queryInterface.createTable('bot_wallet_metrics', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      wallet_index: {
        type: Sequelize.INTEGER,
        allowNull: false
      },
      wallet_address: {
        type: Sequelize.STRING(42),
        allowNull: false
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      orders_placed_grid_buy: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      orders_placed_grid_sell: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      orders_placed_counter_buy: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      orders_placed_counter_sell: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      orders_failed: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      orders_filled: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      volume_usd: {
        type: Sequelize.DECIMAL(20, 2),
        defaultValue: 0.00
      },
      realized_pnl_usd: {
        type: Sequelize.DECIMAL(20, 2),
        defaultValue: 0.00
      },
      fill_rate_percent: {
        type: Sequelize.DECIMAL(5, 2),
        defaultValue: 0.00
      },
      error_count: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      avg_cycle_time_ms: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      total_cycles: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      last_updated: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    // Add unique constraint and indexes for bot_wallet_metrics
    await queryInterface.addConstraint('bot_wallet_metrics', {
      fields: ['wallet_index', 'date'],
      type: 'unique',
      name: 'unique_wallet_date'
    });
    await queryInterface.addIndex('bot_wallet_metrics', ['date'], {
      name: 'idx_date'
    });
    await queryInterface.addIndex('bot_wallet_metrics', ['wallet_index'], {
      name: 'idx_wallet_metrics'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('bot_wallet_metrics');
    await queryInterface.dropTable('bot_error_logs');
  }
};
