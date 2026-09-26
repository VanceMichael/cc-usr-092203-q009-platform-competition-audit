import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_CHANNEL, applyReceipt, createExitCase, reportImpersonation, submitClaim } from '../src/exitCase.js';
import { projectCase } from '../src/access.js';

const subject = { id: '91000000TEST0001', name: '样例科技公司', type: 'company' };
const make = () =>
  createExitCase({ case_id: 'EX-A-1', subject, path: 'ordinary', initiator: 'enterprise', at: '2026-09-01T09:00:00+08:00' });

test('企业可见待办与公开历史，但看不到未公开举报', () => {
  const c = make();
  applyReceipt(c, { receipt_id: 'R-1', department: '税务部门', matter: 'tax_clearance', result: 'cleared', detail: '', at: null });
  reportImpersonation(c, { by: '举报人', detail: '疑似冒名提交', at: null });
  const view = projectCase(c, { role: 'enterprise' });
  assert.ok(view.todos.length > 0);
  assert.ok(view.todos.every((t) => t.status !== 'cleared'));
  assert.ok(!view.history.some((e) => e.type === 'impersonation_report'));
  assert.ok(view.history.some((e) => e.type === 'receipt_applied'));
  assert.equal(view.security_hold, undefined);
});

test('债权人仅见公告信息、受控渠道和自己的申报', () => {
  const c = make();
  submitClaim(c, { claim_id: 'CL-1', creditor_ref: 'creditor-token-A', amount: 5000, channel: CLAIM_CHANNEL, at: null });
  submitClaim(c, { claim_id: 'CL-2', creditor_ref: 'creditor-token-B', amount: 8000, channel: CLAIM_CHANNEL, at: null });
  const view = projectCase(c, { role: 'creditor', creditor_ref: 'creditor-token-A' });
  assert.equal(view.claim_channel, CLAIM_CHANNEL);
  assert.equal(view.announcement.period_days, 45);
  assert.equal(view.own_claims.length, 1);
  assert.equal(view.own_claims[0].claim_id, 'CL-1');
  assert.equal(view.history, undefined);
  assert.equal(view.matters, undefined);
});

test('登记人员可见完整资料，未知角色被拒绝', () => {
  const c = make();
  reportImpersonation(c, { by: '举报人', detail: '疑似冒名提交', at: null });
  const view = projectCase(c, { role: 'registrar' });
  assert.ok(view.security_hold);
  assert.ok(view.history.some((e) => e.type === 'impersonation_report'));
  assert.throws(() => projectCase(c, { role: 'guest' }), /未知的访问角色/);
});
