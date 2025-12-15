'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('sushiswap_activity')
    );

    if (!tableExists) {
      console.log('Table sushiswap_activity does not exist, skipping migration');
      return;
    }

    const tableDescription = await queryInterface.describeTable('sushiswap_activity');

    // Add price_impact column if it doesn't exist
    if (!tableDescription.price_impact) {
      await queryInterface.addColumn('sushiswap_activity', 'price_impact', {
        type: Sequelize.DECIMAL(20, 18),
        allowNull: false,
        defaultValue: 0,
        comment: 'Price impact as a decimal (e.g., 0.0005 = 0.05%)'
      });
      console.log('Added column: price_impact');
    } else {
      console.log('Column price_impact already exists');
    }

    console.log('Migration completed successfully');
  },

  async down(queryInterface, Sequelize) {
    // Check if table exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('sushiswap_activity')
    );

    if (!tableExists) {
      console.log('Table sushiswap_activity does not exist, skipping rollback');
      return;
    }

    const tableDescription = await queryInterface.describeTable('sushiswap_activity');

    // Remove price_impact column if it exists
    if (tableDescription.price_impact) {
      await queryInterface.removeColumn('sushiswap_activity', 'price_impact');
      console.log('Removed column: price_impact');
    }

    console.log('Rollback completed successfully');
  }
};
