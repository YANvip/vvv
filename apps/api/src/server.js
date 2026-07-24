const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { parseAfterSalesText } = require('./rules/parser');
const { catalog: seedCatalog } = require('./rules/catalog');

const app = express();
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

const sessions = new Map();
const cookie = (req, name) => (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name}=`))?.slice(name.length + 1);
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
};
const verifyPassword = (password, stored) => {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};
const safeUser = (row) => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, active: row.active });

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY, username VARCHAR(60) UNIQUE NOT NULL, display_name VARCHAR(100) NOT NULL,
      password_hash TEXT NOT NULL, role VARCHAR(30) NOT NULL DEFAULT 'customer_service',
      active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS product_catalog (
      id BIGSERIAL PRIMARY KEY, model VARCHAR(100) UNIQUE NOT NULL, product_type VARCHAR(100),
      aliases TEXT NOT NULL DEFAULT '', colors TEXT NOT NULL DEFAULT '', color_required BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY, case_id BIGINT, user_id BIGINT, action VARCHAR(60) NOT NULL,
      detail TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE after_sales_cases ADD COLUMN IF NOT EXISTS color VARCHAR(50);
    ALTER TABLE after_sales_cases ADD COLUMN IF NOT EXISTS parsed_raw_text TEXT;
    ALTER TABLE after_sales_cases ADD COLUMN IF NOT EXISTS parse_warnings TEXT;
    ALTER TABLE after_sales_cases ADD COLUMN IF NOT EXISTS assigned_to BIGINT;
    ALTER TABLE after_sales_cases ADD COLUMN IF NOT EXISTS created_by BIGINT;
    ALTER TABLE after_sales_cases ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_after_sales_cases_order_no ON after_sales_cases(order_no);
    CREATE INDEX IF NOT EXISTS idx_after_sales_cases_status ON after_sales_cases(status);
  `);
  const admin = await pool.query('SELECT id FROM users WHERE username=$1', ['admin']);
  if (!admin.rows[0]) {
    await pool.query(
      'INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4)',
      ['admin', '系统管理员', hashPassword(process.env.ADMIN_PASSWORD || 'a123456'), 'admin']
    );
  }
  for (const item of seedCatalog) {
    await pool.query(
      `INSERT INTO product_catalog(model,product_type,aliases,colors,color_required)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(model) DO NOTHING`,
      [item.model, item.productType, item.aliases.join(','), item.colors.join(','), item.colorRequired]
    );
  }
}

async function catalogForParser() {
  const { rows } = await pool.query('SELECT * FROM product_catalog WHERE active=true ORDER BY length(model) DESC');
  return rows.map((x) => ({
    model: x.model,
    productType: x.product_type,
    aliases: x.aliases.split(',').map((v) => v.trim()).filter(Boolean),
    colors: x.colors.split(',').map((v) => v.trim()).filter(Boolean),
    colorRequired: x.color_required,
  }));
}

async function auth(req, res, next) {
  const token = cookie(req, 'as_session');
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: '请先登录' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1 AND active=true', [session.userId]);
  if (!rows[0]) return res.status(401).json({ error: '账号不可用' });
  req.user = rows[0];
  next();
}
const allow = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: '没有操作权限' });
const run = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
async function audit(req, action, caseId, detail = '') {
  await pool.query('INSERT INTO audit_logs(case_id,user_id,action,detail) VALUES($1,$2,$3,$4)', [caseId || null, req.user.id, action, detail]);
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'after-sales-api', version: '1.0.0' }));
app.post('/api/auth/login', run(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1 AND active=true', [String(req.body.username || '').trim()]);
  if (!rows[0] || !verifyPassword(req.body.password, rows[0].password_hash)) return res.status(401).json({ error: '账号或密码错误' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: rows[0].id, expires: Date.now() + 12 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', `as_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  res.json(safeUser(rows[0]));
}));
app.post('/api/auth/logout', auth, (req, res) => {
  sessions.delete(cookie(req, 'as_session'));
  res.setHeader('Set-Cookie', 'as_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/auth/me', auth, (req, res) => res.json(safeUser(req.user)));
app.post('/api/auth/change-password', auth, run(async (req, res) => {
  if (!verifyPassword(req.body.oldPassword, req.user.password_hash)) return res.status(400).json({ error: '原密码不正确' });
  if (String(req.body.newPassword || '').length < 8) return res.status(400).json({ error: '新密码至少8位' });
  await pool.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [hashPassword(req.body.newPassword), req.user.id]);
  await audit(req, '修改登录密码', null);
  res.json({ ok: true });
}));

app.post('/api/parse', auth, run(async (req, res) => res.json(parseAfterSalesText(req.body.text, await catalogForParser()))));

app.get('/api/dashboard', auth, run(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT count(*)::int total,
      count(*) FILTER (WHERE status='need_review')::int need_review,
      count(*) FILTER (WHERE status IN ('pending','processing'))::int pending,
      count(*) FILTER (WHERE status='done')::int done,
      count(*) FILTER (WHERE created_at::date=current_date)::int today
    FROM after_sales_cases`);
  res.json(rows[0]);
}));

app.get('/api/cases', auth, run(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) { params.push(req.query.status); where.push(`c.status=$${params.length}`); }
  if (req.query.type) { params.push(req.query.type); where.push(`c.type=$${params.length}`); }
  if (req.query.platform) { params.push(req.query.platform); where.push(`c.platform=$${params.length}`); }
  if (req.query.keyword) {
    params.push(`%${req.query.keyword}%`);
    where.push(`concat_ws(' ',c.case_no,c.order_no,c.product_name,c.product_sku,c.color,c.resend_tracking_no,c.remark) ILIKE $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT c.*,u.display_name created_by_name FROM after_sales_cases c LEFT JOIN users u ON u.id=c.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.created_at DESC LIMIT 1000`, params);
  res.json(rows);
}));

app.get('/api/cases/export.csv', auth, run(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM after_sales_cases ORDER BY created_at DESC LIMIT 5000');
  const fields = ['case_no','type','status','platform','order_no','product_name','product_sku','quantity','color','resend_tracking_no','reason','remark','created_at'];
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const csv = '\ufeff' + [fields.join(','), ...rows.map((r) => fields.map((f) => esc(r[f])).join(','))].join('\r\n');
  res.type('text/csv').set('Content-Disposition', 'attachment; filename=after-sales.csv').send(csv);
}));

app.get('/api/cases/:id', auth, run(async (req, res) => {
  const item = await pool.query('SELECT * FROM after_sales_cases WHERE id=$1', [req.params.id]);
  if (!item.rows[0]) return res.status(404).json({ error: '记录不存在' });
  const logs = await pool.query('SELECT l.*,u.display_name FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id WHERE case_id=$1 ORDER BY l.created_at DESC', [req.params.id]);
  res.json({ case: item.rows[0], logs: logs.rows });
}));

app.post('/api/cases/from-text', auth, allow('admin', 'customer_service'), run(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: '请输入客服原话' });
  const parsed = { ...parseAfterSalesText(text, await catalogForParser()), ...(req.body.overrides || {}) };
  const duplicate = parsed.orderNo ? await pool.query("SELECT case_no FROM after_sales_cases WHERE order_no=$1 AND status<>'cancelled' LIMIT 1", [parsed.orderNo]) : { rows: [] };
  if (duplicate.rows[0] && !req.body.allowDuplicate) return res.status(409).json({ error: `该订单已有售后单 ${duplicate.rows[0].case_no}`, duplicate: true, parsed });
  const caseNo = `AS${new Date().toISOString().slice(0,10).replaceAll('-','')}${String(Date.now()).slice(-6)}`;
  const warnings = parsed.warnings || [];
  const { rows } = await pool.query(
    `INSERT INTO after_sales_cases(case_no,type,status,platform,shop_name,order_no,customer_name,customer_phone,
      product_name,product_sku,quantity,color,reason,solution,parsed_raw_text,parse_warnings,remark,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [caseNo,parsed.type,parsed.needReview?'need_review':'pending',parsed.platform,req.body.shopName||'',parsed.orderNo,
      req.body.customerName||'',req.body.customerPhone||'',parsed.productName,parsed.model,Number(parsed.quantity)||1,parsed.color||'',
      req.body.reason||text,req.body.solution||parsed.type,text,warnings.join('；'),req.body.remark||'',req.user.id]
  );
  await audit(req, '创建售后单', rows[0].id, text);
  res.status(201).json({ case: rows[0], parsed });
}));

app.patch('/api/cases/:id', auth, run(async (req, res) => {
  const allowed = ['type','status','platform','shop_name','order_no','customer_name','customer_phone','product_name','product_sku','quantity','color','reason','solution','remark'];
  const entries = Object.entries(req.body).filter(([key]) => allowed.includes(key));
  if (!entries.length) return res.status(400).json({ error: '没有可修改内容' });
  const values = entries.map(([, value]) => value);
  values.push(req.params.id);
  const set = entries.map(([key], i) => `${key}=$${i + 1}`).join(',');
  const { rows } = await pool.query(`UPDATE after_sales_cases SET ${set},updated_at=now() WHERE id=$${values.length} RETURNING *`, values);
  if (!rows[0]) return res.status(404).json({ error: '记录不存在' });
  await audit(req, '修改售后单', rows[0].id, entries.map(([k]) => k).join(','));
  res.json(rows[0]);
}));

app.patch('/api/cases/:id/tracking', auth, allow('admin', 'printer'), run(async (req, res) => {
  const trackingNo = String(req.body.trackingNo || '').trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9-]{6,40}$/.test(trackingNo)) return res.status(400).json({ error: '快递单号格式不正确' });
  const { rows } = await pool.query(
    `UPDATE after_sales_cases SET resend_tracking_no=$1,status='done',completed_at=now(),updated_at=now() WHERE id=$2 RETURNING *`,
    [trackingNo, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '记录不存在' });
  await audit(req, '填写快递单号', rows[0].id, trackingNo);
  res.json(rows[0]);
}));

app.get('/api/catalog', auth, run(async (req, res) => res.json((await pool.query('SELECT * FROM product_catalog ORDER BY model')).rows)));
app.post('/api/catalog', auth, allow('admin'), run(async (req, res) => {
  const b = req.body;
  const { rows } = await pool.query(
    `INSERT INTO product_catalog(model,product_type,aliases,colors,color_required) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [b.model,b.productType||'',b.aliases||b.model,b.colors||'',Boolean(b.colorRequired)]);
  res.status(201).json(rows[0]);
}));
app.patch('/api/catalog/:id', auth, allow('admin'), run(async (req, res) => {
  const b = req.body;
  const { rows } = await pool.query(
    `UPDATE product_catalog SET model=$1,product_type=$2,aliases=$3,colors=$4,color_required=$5,active=$6,updated_at=now() WHERE id=$7 RETURNING *`,
    [b.model,b.product_type||'',b.aliases||'',b.colors||'',Boolean(b.color_required),b.active!==false,req.params.id]);
  res.json(rows[0]);
}));

app.get('/api/users', auth, allow('admin'), run(async (req, res) => {
  const { rows } = await pool.query('SELECT id,username,display_name,role,active,created_at FROM users ORDER BY id');
  res.json(rows);
}));
app.post('/api/users', auth, allow('admin'), run(async (req, res) => {
  const b = req.body;
  if (!b.username || String(b.password || '').length < 6) return res.status(400).json({ error: '账号必填，密码至少6位' });
  const { rows } = await pool.query(
    'INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING *',
    [b.username,b.displayName||b.username,hashPassword(b.password),b.role||'customer_service']);
  res.status(201).json(safeUser(rows[0]));
}));
app.patch('/api/users/:id', auth, allow('admin'), run(async (req, res) => {
  const b = req.body;
  if (String(req.params.id) === String(req.user.id) && b.active === false) return res.status(400).json({ error: '不能停用当前登录账号' });
  const password = b.password ? ',password_hash=$4' : '';
  const params = b.password ? [b.displayName,b.role,b.active,hashPassword(b.password),req.params.id] : [b.displayName,b.role,b.active,req.params.id];
  const idPos = params.length;
  const { rows } = await pool.query(`UPDATE users SET display_name=$1,role=$2,active=$3${password},updated_at=now() WHERE id=$${idPos} RETURNING *`, params);
  res.json(safeUser(rows[0]));
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === '23505') return res.status(409).json({ error: '数据重复，请检查账号、型号或单号' });
  res.status(500).json({ error: '服务器处理失败，请稍后重试' });
});

async function start() {
  await migrate();
  app.listen(3000, () => console.log('After-sales API 1.0.0 running on port 3000'));
}
start().catch((err) => { console.error(err); process.exit(1); });
