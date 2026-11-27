// const { Pool } = require("pg");
// require("dotenv").config();

// const isLocal =process.env.DB_HOST === "localhost" || process.env.DB_HOST === "127.0.0.1";
// const pool = new Pool({
//     host: process.env.DB_HOST,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     database: process.env.DB_NAME,
//     port: Number(process.env.DB_PORT),
//     // ssl: {
//     //     rejectUnauthorized: false
//     // }
//      ssl: isLocal
//         ? false
//         : {
//               rejectUnauthorized: false
//           }
// });

// const connectDB = async () => {
//     try {

//         const client = await pool.connect();

//         console.log("✅ PostgreSQL Connected Successfully");

//         client.release();

//     } catch (error) {

//         console.error("❌ Database Connection Failed:", error.message);

//     }
// };

// // console.log("DB URL configured:", Boolean(process.env.DATABASE_URL));
// // console.log("DB host:", process.env.PGHOST || "from DATABASE_URL");
// // console.log("DB name:", process.env.PGDATABASE || "from DATABASE_URL");

// const dbUrl = new URL(process.env.DATABASE_URL);

// console.log("DB host:", dbUrl.hostname);
// console.log("DB port:", dbUrl.port || "5432");
// console.log("DB name:", dbUrl.pathname.slice(1));
// console.log("DB user:", decodeURIComponent(dbUrl.username));
// console.log("Password present:", Boolean(dbUrl.password));

// module.exports = {
//     pool,
//     connectDB
// };



require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing from .env");
}

const dbUrl = new URL(process.env.DATABASE_URL);
const isLocal =
    dbUrl.hostname === "localhost" ||
    dbUrl.hostname === "127.0.0.1";

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal
        ? false
        : { rejectUnauthorized: false }
});

const connectDB = async () => {
    let client;

    try {
        client = await pool.connect();

        const result = await client.query(
            "SELECT current_database(), current_user"
        );

        console.log("✅ PostgreSQL Connected Successfully");
        console.log("Database:", result.rows[0].current_database);
        console.log("User:", result.rows[0].current_user);
    } catch (error) {
        console.error("❌ Database Connection Failed:", error.message);
        throw error;
    } finally {
        client?.release();
    }
};

module.exports = {
    pool,
    connectDB
};
