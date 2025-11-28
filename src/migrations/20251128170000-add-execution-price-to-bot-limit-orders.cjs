'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('bot_limit_orders');

    // Add execution_price column if it doesn't exist
    if (!tableInfo.execution_price) {
      await queryInterface.addColumn('bot_limit_orders', 'execution_price', {
        type: Sequelize.DECIMAL(30, 18),
        allowNull: true,
        after: 'dst_min_amount',
        comment: 'Actual execution price when order fills (filled_dst_amount / filled_src_amount)'
      });
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('bot_limit_orders', 'execution_price');
  }
};
