'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('bot_wallet_executions')
    );

    if (!tableExists) {
      console.log('Table bot_wallet_executions does not exist, skipping migration');
      return;
    }

    const tableDescription = await queryInterface.describeTable('bot_wallet_executions');

    // Add limit_orders_placed column if it doesn't exist
    if (!tableDescription.limit_orders_placed) {
      await queryInterface.addColumn('bot_wallet_executions', 'limit_orders_placed', {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      });
      console.log('Added column: limit_orders_placed');
    } else {
      console.log('Column limit_orders_placed already exists');
    }

    // Add limit_orders_filled column if it doesn't exist
    if (!tableDescription.limit_orders_filled) {
      await queryInterface.addColumn('bot_wallet_executions', 'limit_orders_filled', {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      });
      console.log('Added column: limit_orders_filled');
    } else {
      console.log('Column limit_orders_filled already exists');
    }

    console.log('Migration completed successfully');
  },

  async down(queryInterface, Sequelize) {
    // Check if table exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('bot_wallet_executions')
    );

    if (!tableExists) {
      console.log('Table bot_wallet_executions does not exist, skipping rollback');
      return;
    }

    const tableDescription = await queryInterface.describeTable('bot_wallet_executions');

    // Remove limit_orders_filled column if it exists
    if (tableDescription.limit_orders_filled) {
      await queryInterface.removeColumn('bot_wallet_executions', 'limit_orders_filled');
      console.log('Removed column: limit_orders_filled');
    }

    // Remove limit_orders_placed column if it exists
    if (tableDescription.limit_orders_placed) {
      await queryInterface.removeColumn('bot_wallet_executions', 'limit_orders_placed');
      console.log('Removed column: limit_orders_placed');
    }

    console.log('Rollback completed successfully');
  }
};