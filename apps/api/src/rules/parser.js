const { catalog: defaultCatalog } = require('./catalog');

const chineseNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function detectOrderNo(text) {
  const pdd = text.match(/\d{5,8}-\d{10,24}/);
  if (pdd) return { orderNo: pdd[0], platform: '拼多多' };
  const douyin = text.match(/(?<!\d)\d{16,22}(?!\d)/);
  if (douyin) return { orderNo: douyin[0], platform: '抖店' };
  const taobao = text.match(/(?<!\d)\d{12,15}(?!\d)/);
  if (taobao) return { orderNo: taobao[0], platform: '淘宝/天猫' };
  return { orderNo: '', platform: '未知平台' };
}

function detectType(text) {
  if (/换货|换新|更换/.test(text)) return '换货';
  if (/退件|退回|退货/.test(text)) return '退件';
  return '补发';
}

function detectQuantity(text) {
  const arabic = text.match(/(\d+)\s*(个|件|只|套|张|把)/);
  if (arabic) return Math.max(1, Number(arabic[1]));
  const chinese = text.match(/([一二两三四五六七八九十])\s*(个|件|只|套|张|把)/);
  return chinese ? chineseNumbers[chinese[1]] : 1;
}

function normalizeColor(color) {
  return ({ 灰: '灰色', 高灰: '高级灰' })[color] || color || '';
}

function detectProduct(text, catalog) {
  const sorted = [...catalog].sort((a, b) => {
    const aLen = Math.max(...a.aliases.map((x) => x.length));
    const bLen = Math.max(...b.aliases.map((x) => x.length));
    return bLen - aLen;
  });
  for (const item of sorted) {
    if (!item.aliases.some((name) => text.includes(name.replace(/\s+/g, '')))) continue;
    const color = item.colorRequired
      ? [...item.colors].sort((a, b) => b.length - a.length).find((name) => text.includes(name))
      : '';
    return {
      model: item.model,
      productName: item.model,
      productType: item.productType,
      color: normalizeColor(color),
      colorRequired: item.colorRequired,
    };
  }
  return { model: '', productName: '', productType: '', color: '', colorRequired: false };
}

function parseAfterSalesText(input, customCatalog = defaultCatalog) {
  const rawText = String(input || '').trim();
  const text = rawText.replace(/\s+/g, '');
  const order = detectOrderNo(text);
  const product = detectProduct(text, customCatalog);
  const result = { rawText, ...order, type: detectType(text), quantity: detectQuantity(text), ...product };
  const warnings = [];
  if (!result.orderNo) warnings.push('未识别订单号');
  if (result.platform === '未知平台') warnings.push('未识别平台');
  if (!result.model) warnings.push('未识别商品型号');
  if (result.colorRequired && !result.color) warnings.push('该商品需要确认颜色');
  if (result.color === '灰色') warnings.push('“灰色”可能对应多个色号，请人工确认');
  return { ...result, needReview: warnings.length > 0, warnings };
}

module.exports = { parseAfterSalesText };
