const assert = require('assert');
const { parseAfterSalesText } = require('./parser');

let result = parseAfterSalesText('260708-560380003972903 补发两个6600灰');
assert.equal(result.platform, '拼多多');
assert.equal(result.quantity, 2);
assert.equal(result.model, '6600');
assert.equal(result.color, '灰色');

result = parseAfterSalesText('6953585234348872915补发5个6600脚垫');
assert.equal(result.platform, '抖店');
assert.equal(result.quantity, 5);
assert.equal(result.model, '6600脚垫');
assert.equal(result.color, '');

console.log('Parser tests passed');
