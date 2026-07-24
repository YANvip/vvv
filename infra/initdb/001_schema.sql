CREATE TABLE IF NOT EXISTS after_sales_cases (
  id BIGSERIAL PRIMARY KEY,
  case_no VARCHAR(50) UNIQUE NOT NULL,
  type VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  platform VARCHAR(30),
  shop_name VARCHAR(100),
  order_no VARCHAR(100),
  customer_name VARCHAR(100),
  customer_phone VARCHAR(50),
  product_name VARCHAR(255),
  product_sku VARCHAR(100),
  quantity INTEGER DEFAULT 1,
  color VARCHAR(50),
  reason TEXT,
  solution TEXT,
  resend_tracking_no VARCHAR(100),
  exchange_out_tracking_no VARCHAR(100),
  exchange_return_tracking_no VARCHAR(100),
  return_tracking_no VARCHAR(100),
  owner_name VARCHAR(100),
  parsed_raw_text TEXT,
  parse_warnings TEXT,
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_after_sales_cases_order_no ON after_sales_cases(order_no);
CREATE INDEX IF NOT EXISTS idx_after_sales_cases_status ON after_sales_cases(status);
CREATE INDEX IF NOT EXISTS idx_after_sales_cases_platform ON after_sales_cases(platform);
