// 请求头规范化自检：逐跳头必须剥离、host 必须改写为真实上游、authorization 与 content-type 必须保留
// 路径约定：本文件位于 tests/，仓库根是上一级
const assert = require('node:assert/strict');
const { HOP_BY_HOP, normalizeHeaders } = require('../src/headers.cjs');

// 中文注释：构造包含全部逐跳头 + 鉴权头 + 业务头的请求头
const input = {
  connection: 'keep-alive',
  'keep-alive': 'timeout=5',
  te: 'trailers',
  trailer: 'x-checksum',
  'transfer-encoding': 'chunked',
  upgrade: 'h2c',
  'proxy-authenticate': 'Basic realm="x"',
  'proxy-authorization': 'Basic c2VjcmV0',
  host: '127.0.0.1:15731',
  authorization: 'Bearer SECRET-TOKEN-12345',
  'content-type': 'application/json',
  'openai-beta': 'responses=v1',
};

const out = normalizeHeaders(input, '127.0.0.1', 15721);

// 中文注释：逐跳头必须全部删除
for (const name of HOP_BY_HOP) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(out, name),
    false,
    '逐跳头必须被删除：' + name,
  );
}

// 中文注释：host 改写为真实上游地址
assert.equal(out.host, '127.0.0.1:15721');

// 中文注释：鉴权头与业务头必须原样保留
assert.equal(out.authorization, 'Bearer SECRET-TOKEN-12345');
assert.equal(out['content-type'], 'application/json');
assert.equal(out['openai-beta'], 'responses=v1');
assert.equal(Object.keys(out).length, 4);

// 中文注释：不传上游端口时，host 只保留主机名
const noPort = normalizeHeaders({ host: '127.0.0.1:15731' }, 'upstream.local', undefined);
assert.equal(noPort.host, 'upstream.local');

// 中文注释：原始请求头对象不得被就地修改
assert.equal(input.connection, 'keep-alive');
assert.equal(input.host, '127.0.0.1:15731');

// 中文注释：逐跳头清单必须与 RFC 7230 约定一致
assert.deepEqual(HOP_BY_HOP, [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

console.log('HEADERS_TEST_PASS');
