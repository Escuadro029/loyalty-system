const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public")); // serves index.html + qrcodes/

// ----------------------
// SQLite DB
// ----------------------
const db = new sqlite3.Database("./loyalty.db");

// ----------------------
// Create tables
// ----------------------
db.run(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firstName TEXT,
  lastName TEXT,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  code TEXT UNIQUE,
  points INTEGER DEFAULT 0,
  amount REAL DEFAULT 0
)
`);

db.run(`
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  description TEXT,
  amount REAL,
  points INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

// ----------------------
// Generate unique customer code
// ----------------------
function generateCode() {
  // Get today's date in YYYYMMDD format
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0"); // Months are 0-indexed
  const dd = String(today.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;

  // Generate 6-character random hex
  const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();

  // Combine label + date + random hex
  return `LUNA-${dateStr}-${randomHex}`;
}

// ----------------------
// Register customer
// ----------------------
app.post("/register", async (req, res) => {
  const { firstName, lastName, email, phone, amount } = req.body;

  // Validate input
  if (!firstName || !lastName || !/^09\d{9}$/.test(phone)) {
    return res.send({ error: "Invalid input. Ensure all fields are filled correctly." });
  }

  const code = generateCode();

  db.run(
    `INSERT INTO customers (firstName, lastName, email, phone, code, points, amount)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [firstName, lastName, email || null, phone, code, amount || 0],
    async function (err) {
      if (err) return res.send({ error: "Phone or email already exists" });

      try {
        const qrFolder = path.join(__dirname, "public", "qrcodes");
        if (!fs.existsSync(qrFolder)) fs.mkdirSync(qrFolder, { recursive: true });

        const qrPath = path.join(qrFolder, `${code}.png`);
        const qrValue = `"${code}"`;

        await QRCode.toFile(qrPath, qrValue, { width: 400, margin: 2 });

        if (amount && amount > 0) {
          db.run("INSERT INTO transactions (code, amount, points) VALUES (?, ?, ?)", [code, amount, 1]);
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
        res.send({ error: "QR generation failed" });
      }
    }
  );
});

// ----------------------
// Add points & amount
// ----------------------
app.post("/add-point", (req, res) => {
  let { code, amount } = req.body;

  code = (code || "").toUpperCase(); // normalize

  db.get("SELECT * FROM customers WHERE UPPER(code) = ?", [code], (err, row) => {
    if (err) return res.status(500).send({ error: "DB error" });
    if (!row) return res.status(404).send({ error: "Customer gdfgfdgdf not found" });

    const newPoints = (row.points || 0) + 1;
    const newAmount = (row.amount || 0) + (amount || 0);

    db.run(
      "UPDATE customers SET points = ?, amount = ? WHERE UPPER(code) = ?",
      [newPoints, newAmount, code],
      function (err) {
        if (err) return res.status(500).send({ error: "Update failed" });

        if (amount && amount > 0) {
          db.run(
            "INSERT INTO transactions (code, amount, points) VALUES (?, ?, ?)",
            [code, amount, 1]
          );
        }

        db.all(
          "SELECT * FROM transactions WHERE UPPER(code) = ? ORDER BY created_at DESC",
          [code],
          (err, txs) => {
            if (err) return res.status(500).send({ error: "Cannot fetch transactions" });
            res.json({
              code,
              firstName: row.firstName,
              lastName: row.lastName,
              email: row.email,
              points: newPoints,
              amount: newAmount,
              transactions: txs,
            });
          }
        );
      }
    );
  });
});


// ----------------------
// Get all customers
// ----------------------
app.get("/customers", (req, res) => {
  db.all("SELECT * FROM customers ORDER BY id DESC", (err, rows) => {
    if (err) return res.status(500).send({ error: "DB error" });
    res.json(rows);
  });
});


// Get single customer by code, including transactions
app.get("/customers/:code", (req, res) => {
  const { code } = req.params;
  // Find customer
  db.get("SELECT * FROM customers WHERE code = ?", [code], (err, customer) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    // Fetch transactions
    db.all(
      "SELECT * FROM transactions WHERE code = ? ORDER BY created_at DESC",
      [code],
      (err, transactions) => {
        if (err) return res.status(500).json({ error: "Cannot fetch transactions" });

        // Attach transactions to customer object
        customer.transactions = transactions || [];
        // Return full customer record
        res.json(customer);
      }
    );
  });
});

app.post("/customers/:code/redeem", async (req, res) => {
  try {
    const { code } = req.params;
    let { amount } = req.body;
    amount = Number(amount);

    if (isNaN(amount) || amount <= 0) return res.status(400).send("Invalid amount");

    const customer = await db.get("SELECT * FROM customers WHERE code = ?", code);
    if (!customer) return res.status(404).send("Customer not found");

    const customerAmount = Number(customer.amount) || 0;
    const redeemAmount = Math.min(amount, customerAmount);
    const remainingAmount = customerAmount - redeemAmount;

    console.log('Redeem:', redeemAmount, 'Remaining:', remainingAmount);

    await db.run("UPDATE customers SET amount = ? WHERE code = ?", remainingAmount, code);

    await db.run(
      "INSERT INTO transactions (code, description, points, amount, created_at) VALUES (?, ?, ?, ?, ?)",
      code,
      "redeem",
      0,
      amount,
      new Date().toISOString()
    );

    res.send("ok");


  } catch (err) {
    console.error("Redeem error:", err);
    res.status(500).send("Server error: " + err.message);
  }
});








// ----------------------
// Start server
// ----------------------
app.listen(3000, () => console.log("Server running on port 3000"));




