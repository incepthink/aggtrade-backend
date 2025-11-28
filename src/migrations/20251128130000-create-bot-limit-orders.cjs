'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table already exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('bot_limit_orders')
    );

    if (tableExists) {
      console.log('Table bot_limit_orders already exists');

      // Check if execution_id is the wrong type and fix it
      const tableDescription = await queryInterface.describeTable('bot_limit_orders');

      // If execution_id exists but is BIGINT, we need to change it to VARCHAR
      if (tableDescription.execution_id) {
        console.log('Modifying execution_id column from BIGINT to VARCHAR(100)');

        // First, drop the foreign key constraint if it exists
        try {
          await queryInterface.removeConstraint('bot_limit_orders', 'bot_limit_orders_ibfk_1');
        } catch (error) {
          console.log('No foreign key constraint to remove or already removed');
        }

        // Change the column type
        await queryInterface.changeColumn('bot_limit_orders', 'execution_id', {
          type: Sequelize.STRING(100),
          allowNull: false
        });

        // Re-add the foreign key constraint to the correct column
        await queryInterface.addConstraint('bot_limit_orders', {
          fields: ['execution_id'],
          type: 'foreign key',
          name: 'bot_limit_orders_execution_id_fk',
          references: {
            table: 'bot_executions',
            field: 'execution_id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        });

        console.log('Modified execution_id column successfully');
      }

      return;
    }

    // Create the table
    await queryInterface.createTable('bot_limit_orders', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      execution_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
        references: {
          model: 'bot_executions',
          key: 'execution_id'
        },
        onDelete: 'CASCADE'
      },
      wallet_index: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false
      },
      wallet_address: {
        type: Sequelize.STRING(42),
        allowNull: false
      },
      order_id: {
        type: Sequelize.STRING(100),
        allowNull: false
      },
      tx_hash: {
        type: Sequelize.STRING(66),
        allowNull: false
      },
      chain_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 747474
      },
      src_token_address: {
        type: Sequelize.STRING(42),
        allowNull: false
      },
      src_token_symbol: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      src_amount: {
        type: Sequelize.DECIMAL(30, 18),
        allowNull: false
      },
      dst_token_address: {
        type: Sequelize.STRING(42),
        allowNull: false
      },
      dst_token_symbol: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      dst_min_amount: {
        type: Sequelize.DECIMAL(30, 18),
        allowNull: false
      },
      filled_src_amount: {
        type: Sequelize.DECIMAL(30, 18),
        allowNull: false,
        defaultValue: 0
      },
      filled_dst_amount: {
        type: Sequelize.DECIMAL(30, 18),
        allowNull: false,
        defaultValue: 0
      },
      progress: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0
      },
      usd_volume: {
        type: Sequelize.DECIMAL(30, 6),
        allowNull: false,
        defaultValue: 0
      },
      status: {
        type: Sequelize.ENUM('pending', 'partial', 'filled', 'canceled', 'expired'),
        allowNull: false,
        defaultValue: 'pending'
      },
      placed_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      filled_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      deadline: {
        type: Sequelize.BIGINT,
        allowNull: true
      },
      metadata: {
        type: Sequelize.JSON,
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
    await queryInterface.addIndex('bot_limit_orders', ['execution_id'], {
      name: 'idx_execution_id'
    });

    await queryInterface.addIndex('bot_limit_orders', ['wallet_address'], {
      name: 'idx_wallet_address'
    });

    await queryInterface.addIndex('bot_limit_orders', ['order_id'], {
      name: 'idx_order_id'
    });

    await queryInterface.addIndex('bot_limit_orders', ['status'], {
      name: 'idx_status'
    });

    await queryInterface.addIndex('bot_limit_orders', ['execution_id', 'wallet_address'], {
      name: 'idx_execution_wallet'
    });

    console.log('Created table: bot_limit_orders');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('bot_limit_orders');
    console.log('Dropped table: bot_limit_orders');
  }
};