'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add status column to balance_history table
    await queryInterface.addColumn('balance_history', 'status', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'success',
      after: 'yearnfi'
    });

    // Update existing records to have 'success' status by default
    await queryInterface.sequelize.query(`
      UPDATE balance_history
      SET status = 'success'
      WHERE status IS NULL
    `);
  },

  async down(queryInterface, Sequelize) {
    // Remove status column from balance_history table
    await queryInterface.removeColumn('balance_history', 'status');
  }
};
