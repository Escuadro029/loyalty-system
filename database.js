const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("customers.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE,
    code TEXT UNIQUE,
    points INTEGER DEFAULT 0,
    amount REAL DEFAULT 0
  )`);
});

module.exports = db;
