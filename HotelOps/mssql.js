const sql = require("mssql");
require("dotenv").config();

// ============================================================
// MSSQL DATABASE CONFIGURATION
// ============================================================

const mssqlConfig = {
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  server: process.env.MSSQL_HOST,
  database: process.env.MSSQL_DATABASE,
  port: Number(process.env.MSSQL_PORT || 1433),

  options: {
    encrypt: process.env.MSSQL_ENCRYPT === "true",
    trustServerCertificate:
      process.env.MSSQL_TRUST_SERVER_CERTIFICATE === "true",
  },

  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },

  connectionTimeout: 15000,
  requestTimeout: 30000,
};

// ============================================================
// CONNECTION POOL
// ============================================================

let poolPromise = null;

const getMssqlPool = async () => {
  if (!poolPromise) {
    const connectionPool = new sql.ConnectionPool(mssqlConfig);

    poolPromise = connectionPool.connect().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }

  return poolPromise;
};

// ============================================================
// TEST DATABASE CONNECTION
// ============================================================

const connectMSSQL = async () => {
  try {
    const pool = await getMssqlPool();

    const result = await pool.request().query(`
      SELECT DB_NAME() AS DatabaseName
    `);

    console.log("✅ MSSQL Connected Successfully");
    // console.log("📦 Database:", result.recordset[0].DatabaseName);

    return true;
  } catch (error) {
    console.error("❌ MSSQL Connection Failed:", error.message);

    return false;
  }
};

module.exports = {
  sql,
  getMssqlPool,
  connectMSSQL,
};