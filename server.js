const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg"); // PostgreSQL

const app = express();
app.use(express.json());
app.use(express.static("public")); // serves index.html + qrcodes/

// ----------------------
// PostgreSQL setup
// ----------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Set this in Render environment variables
  ssl: { rejectUnauthorized: false } // required on Render
});

// ----------------------
// Create tables if not exist
// ----------------------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      firstName TEXT NOT NULL,
      lastName TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT UNIQUE NOT NULL,
      code TEXT UNIQUE NOT NULL,
      points INTEGER DEFAULT 0,
      amount NUMERIC DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      description TEXT,
      amount NUMERIC,
      points INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

initDB().catch(console.error);

// ----------------------
// Generate unique customer code
// ----------------------
function generateCode() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;
  const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `LUNA-${dateStr}-${randomHex}`;
}

// ----------------------
// Register customer
// ----------------------
app.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, email, phone, amount } = req.body;

    if (!firstName || !lastName || !/^09\d{9}$/.test(phone)) {
      return res.send({ error: "Invalid input. Ensure all fields are filled correctly." });
    }

    const code = generateCode();

    const insertCustomer = `
      INSERT INTO customers (firstName, lastName, email, phone, code, points, amount)
      VALUES ($1, $2, $3, $4, $5, 0, $6)
      RETURNING *
    `;

    const result = await pool.query(insertCustomer, [
      firstName,
      lastName,
      email || null,
      phone,
      code,
      amount || 0
    ]);

    const customer = result.rows[0];

    const qrFolder = path.join(__dirname, "public", "qrcodes");
    if (!fs.existsSync(qrFolder)) fs.mkdirSync(qrFolder, { recursive: true });

    const qrPath = path.join(qrFolder, `${code}.png`);
    const qrValue = `"${code}"`;
    await QRCode.toFile(qrPath, qrValue, { width: 400, margin: 2 });

    if (amount && amount > 0) {
      await pool.query(
        "INSERT INTO transactions (code, amount, points) VALUES ($1, $2, $3)",
        [code, amount, 1]
      );
    }

    res.send({
      message: "Customer registered",
      code,
      qrPath: `/qrcodes/${code}.png`,
      firstName,
      lastName
    });

  } catch (err) {
    console.error(err);
    res.send({ error: "Registration failed: " + err.message });
  }
});

// ----------------------
// Add points & amount
// ----------------------
app.post("/add-point", async (req, res) => {
  try {
    let { code, amount } = req.body;
    code = (code || "").toUpperCase();

    const customerResult = await pool.query(
      "SELECT * FROM customers WHERE UPPER(code) = $1",
      [code]
    );

    if (customerResult.rows.length === 0) return res.status(404).send({ error: "Customer not found" });

    const customer = customerResult.rows[0];
    const newPoints = (customer.points || 0) + 1;
    const newAmount = (customer.amount || 0) + (amount || 0);

    await pool.query(
      "UPDATE customers SET points = $1, amount = $2 WHERE UPPER(code) = $3",
      [newPoints, newAmount, code]
    );

    if (amount && amount > 0) {
      await pool.query(
        "INSERT INTO transactions (code, amount, points) VALUES ($1, $2, $3)",
        [code, amount, 1]
      );
    }

    const txsResult = await pool.query(
      "SELECT * FROM transactions WHERE UPPER(code) = $1 ORDER BY created_at DESC",
      [code]
    );

    res.json({
      code,
      firstName: customer.firstname,
      lastName: customer.lastname,
      email: customer.email,
      points: newPoints,
      amount: newAmount,
      transactions: txsResult.rows
    });

  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to add point: " + err.message });
  }
});

// ----------------------
// Get all customers
// ----------------------
app.get("/customers", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM customers ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).send({ error: "DB error: " + err.message });
  }
});

// Get single customer + transactions
app.get("/customers/:code", async (req, res) => {
  try {
    const { code } = req.params;

    const custResult = await pool.query(
      "SELECT * FROM customers WHERE code = $1",
      [code]
    );
    if (custResult.rows.length === 0) return res.status(404).send({ error: "Customer not found" });

    const customer = custResult.rows[0];
    const txResult = await pool.query(
      "SELECT * FROM transactions WHERE code = $1 ORDER BY created_at DESC",
      [code]
    );

    customer.transactions = txResult.rows;
    res.json(customer);

  } catch (err) {
    console.error(err);
    res.status(500).send({ error: err.message });
  }
});

// Redeem
app.post("/customers/:code/redeem", async (req, res) => {
  try {
    const { code } = req.params;
    let { amount } = req.body;
    amount = Number(amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).send("Invalid amount");

    const custResult = await pool.query("SELECT * FROM customers WHERE code = $1", [code]);
    if (custResult.rows.length === 0) return res.status(404).send("Customer not found");

    const customer = custResult.rows[0];
    const redeemAmount = Math.min(amount, Number(customer.amount) || 0);
    const remainingAmount = (Number(customer.amount) || 0) - redeemAmount;

    await pool.query("UPDATE customers SET amount = $1 WHERE code = $2", [remainingAmount, code]);
    await pool.query(
      "INSERT INTO transactions (code, description, points, amount, created_at) VALUES ($1, $2, $3, $4, $5)",
      [code, "redeem", 0, redeemAmount, new Date()]
    );

    res.send("ok");
  } catch (err) {
    console.error("Redeem error:", err);
    res.status(500).send("Server error: " + err.message);
  }
});

app.get("/admin", async (req, res) => {
  try {
    const customers = await pool.query("SELECT * FROM customers ORDER BY id DESC");
    const transactions = await pool.query("SELECT * FROM transactions ORDER BY created_at DESC");
ß
    res.send(`
      <h1>Customers</h1>
      <pre>${JSON.stringify(customers.rows, null, 2)}</pre>

      <h1>Transactions</h1>
      <pre>${JSON.stringify(transactions.rows, null, 2)}</pre>
    `);
  } catch (err) {
    res.send("Error: " + err.message);
  }
});


// ----------------------
// Start server
// ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
