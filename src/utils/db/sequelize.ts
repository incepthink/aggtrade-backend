import { Sequelize, Dialect, Options } from 'sequelize'

import config from '../../config/dbConfig.json'

const env = process.env.NODE_ENV || 'development'
const configForEnv = config[env as keyof typeof config]

if (!configForEnv) {
  throw new Error(`No configuration found for environment: ${env}`)
}

const { database, username, password, ...rest } = configForEnv
console.log(
  `Database: ${database}, Username: ${username}, Password: ${password}`
)
const hostEnvName = `${env.toUpperCase()}_DB_HOST`

const sequelizeOptions: Options = {
  ...(rest as { dialect: Dialect }),
  host: process.env[hostEnvName] || rest.host
}

const sequelize = new Sequelize(database, username, password, sequelizeOptions)

export default sequelize
