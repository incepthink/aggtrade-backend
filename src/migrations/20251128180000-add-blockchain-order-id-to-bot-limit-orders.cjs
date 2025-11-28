'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('bot_limit_orders');

    // Add blockchain_order_id column if it doesn't exist
    if (!tableInfo.blockchain_order_id) {
      await queryInterface.addColumn('bot_limit_orders', 'blockchain_order_id', {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        after: 'order_id',
        comment: 'Real order ID from TWAP SDK blockchain (NOT tx_hash)'
      });
    }

    // Add unique index for blockchain_order_id if it doesn't exist
    const indexes = await queryInterface.showIndex('bot_limit_orders');
    const hasBlockchainIndex = indexes.some(index => index.name === 'idx_blockchain_order_id');

    if (!hasBlockchainIndex) {
      await queryInterface.addIndex('bot_limit_orders', ['blockchain_order_id'], {
        name: 'idx_blockchain_order_id',
        unique: true
      });
    }
  },

  async down(queryInterface, Sequelize) {
    // Remove index first
    await queryInterface.removeIndex('bot_limit_orders', 'idx_blockchain_order_id');

    // Remove column
    await queryInterface.removeColumn('bot_limit_orders', 'blockchain_order_id');
  }
};
