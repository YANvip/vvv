const { catalog } = require('./catalog');

const chineseNumbers = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function detectOrderNo(text) {
  const pdd = text.match(/\b\d{5,8}-\d{10,24}\b/);
  if (pdd) return { orderNo: pdd[0], platform: '拼多多' };

  const douyin = text.match(/\b\d{16,22}\b/);
  if (douyin) return { orderNo: douyin[0], platform: '抖店' };

  return { orderNo: '', platform: '未知平台' };
}

function detectType(text) {
  if (/换货|换新|更换/.test(text)) return '换货';
  if (/退件|退回|退货/.test(text)) return '退件';
  if (/补发|重发|少发|补/.test(text)) return '补发';
  return '补发';
}

function detectQuantity(text) {
  const numberMatch = text.match(/(\d+)\s*(个|件|只|套)/);
  if (numberMatch) return Number(numberMatch[1]);

  const chineseMatch = text.match(/([一二两三四五六七八九十])\s*(个|件|只|套)/);
  if (chineseMatch) return chineseNumbers[chineseMatch[1]] || 1;

  return 1;
}

function normalizeColor(color) {
  const map = {
    灰: '灰色',
    高灰: '高级灰',
  };
  return map[color] || color || '';
}

function detectProduct(text) {
  const sorted = [...catalog].sort((a, b) => {
    const aLen = Math.max(...a.aliases.map((x) => x.length));
    const bLen = Math.max(...b.aliases.map((x) => x.length));
    return bLen - aLen;
  });

  for (const item of sorted) {
    const alias = item.aliases.find((name) => text.includes(name));
    if (!alias) continue;

    let color = '';
    if (item.colorRequired) {
      color = item.colors
        .slice()
        .sort((a, b) => b.length - a.length)
        .find((name) => text.includes(name));
    }

    return {
      model: item.model,
      productName: item.productType === '配件' ? item.model : `${item.model}${color ? normalizeColor(color) : ''}`,
      productType: item.productType,
      color: item.colorRequired ? normalizeColor(color) : '',
      colorRequired: item.colorRequired,
    };
  }

  return {
    model: '',
    productName: '',
    productType: '',
    color: '',
    colorRequired: false,
  };
}

function parseAfterSalesText(input) {
  const text = String(input || '').replace(/\s+/g, '');
  const order = detectOrderNo(text);
  const product = detectProduct(text);
  const result = {
    rawText: input,
    orderNo: order.orderNo,
    platform: order.platform,
    type: detectType(text),
    quantity: detectQuantity(text),
    ...product,
  };

  const warnings = [];
  if (!result.orderNo) warnings.push('未识别订单号');
  if (result.platform === '未知平台') warnings.push('未识别平台');
  if (!result.model) warnings.push('未识别商品型号');
  if (result.colorRequired && !result.color) warnings.push('未识别颜色');
  if (result.color === '灰色') warnings.push('颜色灰色可能需要人工确认具体色号');

  return {
    ...result,
    needReview: warnings.length > 0,
    warnings,
  };
}

module.exports = { parseAfterSalesText };
