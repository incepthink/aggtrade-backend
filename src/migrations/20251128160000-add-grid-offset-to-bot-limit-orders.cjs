'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('bot_limit_orders');

    // Add grid_offset_percent column if it doesn't exist
    if (!tableInfo.grid_offset_percent) {
      await queryInterface.addColumn('bot_limit_orders', 'grid_offset_percent', {
        type: Sequelize.DECIMAL(6, 2),
        allowNull: true,
        after: 'order_type',
        comment: 'Grid offset percentage: -3.00, -2.00, -1.00, +1.00, +2.00, +3.00 for grid orders; NULL for counter-orders'
      });
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('bot_limit_orders', 'grid_offset_percent');
  }
};
