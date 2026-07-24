const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { parseAfterSalesText } = require('./rules/parser');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'after-sales-api' });
});

app.post('/api/parse', (req, res) => {
  res.json(parseAfterSalesText(req.body.text));
});

app.get('/api/cases', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM after_sales_cases ORDER BY created_at DESC LIMIT 500');
  res.json(rows);
});

app.post('/api/cases/from-text', async (req, res) => {
  const parsed = parseAfterSalesText(req.body.text);
  const caseNo = `AS${Date.now()}`;
  const { rows } = await pool.query(
    `INSERT INTO after_sales_cases
    (case_no, type, status, platform, order_no, product_name, product_sku, quantity, reason, solution, remark)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *`,
    [
      caseNo,
      parsed.type,
      parsed.needReview ? 'need_review' : 'pending',
      parsed.platform,
      parsed.orderNo,
      parsed.productName,
      parsed.model,
      parsed.quantity,
      req.body.text,
      parsed.type,
      parsed.warnings.join('；'),
    ]
  );

  res.status(201).json({ case: rows[0], parsed });
});

app.listen(3000, () => {
  console.log('After-sales API running on port 3000');
});
