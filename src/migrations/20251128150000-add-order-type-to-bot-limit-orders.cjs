'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('bot_limit_orders');

    // Add order_type column if it doesn't exist
    if (!tableInfo.order_type) {
      await queryInterface.addColumn('bot_limit_orders', 'order_type', {
        type: Sequelize.ENUM('grid_buy', 'grid_sell', 'counter_buy', 'counter_sell'),
        allowNull: false,
        defaultValue: 'grid_buy',
        after: 'parent_order_id'
      });
    }

    // Add index for order_type if it doesn't exist
    const indexes = await queryInterface.showIndex('bot_limit_orders');
    const hasTypeIndex = indexes.some(index => index.name === 'idx_order_type');

    if (!hasTypeIndex) {
      await queryInterface.addIndex('bot_limit_orders', ['order_type'], {
        name: 'idx_order_type'
      });
    }
  },

  async down(queryInterface, Sequelize) {
    // Remove index first
    await queryInterface.removeIndex('bot_limit_orders', 'idx_order_type');

    // Remove column
    await queryInterface.removeColumn('bot_limit_orders', 'order_type');

    // Drop the ENUM type
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_bot_limit_orders_order_type";');
  }
};
