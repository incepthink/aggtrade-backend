'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('bot_limit_orders');

    // Add parent_order_id column if it doesn't exist
    if (!tableInfo.parent_order_id) {
      await queryInterface.addColumn('bot_limit_orders', 'parent_order_id', {
        type: Sequelize.STRING(100),
        allowNull: true,
        after: 'order_id'
      });
    }

    // Add index for parent_order_id if it doesn't exist
    const indexes = await queryInterface.showIndex('bot_limit_orders');
    const hasParentIndex = indexes.some(index => index.name === 'idx_parent_order_id');

    if (!hasParentIndex) {
      await queryInterface.addIndex('bot_limit_orders', ['parent_order_id'], {
        name: 'idx_parent_order_id'
      });
    }
  },

  async down(queryInterface, Sequelize) {
    // Remove index first
    await queryInterface.removeIndex('bot_limit_orders', 'idx_parent_order_id');

    // Remove column
    await queryInterface.removeColumn('bot_limit_orders', 'parent_order_id');
  }
};
