import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CLAIM_CHANNEL,
  applyReceipt,
  changeLiquidationGroup,
  clearSecurityHold,
  createExitCase,
  evaluateExit,
  fileObjection,
  formDecision,
  parseExitCase,
  reportImpersonation,
  resolveClaim,
  resolveObjection,
  restore,
  revokeDecision,
  submitClaim,
  withdraw,
} from '../src/exitCase.js';

const subject = { id: '91000000TEST0001', name: '样例科技公司', type: 'company' };
const make = (path = 'ordinary', initiator = 'enterprise') =>
  createExitCase({ case_id: 'EX-T-1', subject, path, initiator, at: '2026-09-01T09:00:00+08:00' });
const receipt = (matter, result = 'cleared', id = `R-${matter}`) => ({
  receipt_id: id,
  department: '核验部门',
  matter,
  result,
  detail: '',
  at: '2026-09-05T10:00:00+08:00',
});
const clearAll = (c) => {
  for (const m of c.matters) applyReceipt(c, receipt(m.kind, 'cleared', `R-${m.kind}`));
};

test('按路径生成事项清单，路径适用性受控', () => {
  const ordinary = make('ordinary');
  assert.equal(ordinary.matters.length, 7);
  assert.ok(ordinary.matters.every((m) => m.status === 'pending'));
  const suspension = createExitCase({
    case_id: 'EX-T-2',
    subject: { id: '92000000TEST0002', name: '样例便利店', type: 'individual_business' },
    path: 'suspension',
    at: '2026-09-01T09:00:00+08:00',
  });
  assert.equal(suspension.matters.length, 3);
  assert.ok(suspension.matters.every((m) => !m.blocking));
  assert.throws(() => make('suspension'), /停业登记仅适用于个体工商户/);
  assert.throws(() => make('forced'), /强制退出只能由登记机关依职权发起/);
  assert.throws(() => make('unknown-path'), /未知退出路径/);
});

test('重复回执只应用一次，不影响其他事项', () => {
  const c = make();
  const first = applyReceipt(c, receipt('tax_clearance'));
  const second = applyReceipt(c, receipt('tax_clearance'));
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  const tax = c.matters.find((m) => m.kind === 'tax_clearance');
  assert.equal(tax.status, 'cleared');
  assert.equal(tax.receipts.length, 1);
  assert.equal(c.matters.filter((m) => m.status === 'pending').length, 6);
});

test('迟到回执只更新对应事项，不改写已形成的决定', () => {
  const c = make();
  clearAll(c);
  const decision = formDecision(c, { by: '登记员甲', at: '2026-09-20T10:00:00+08:00' });
  assert.equal(decision.outcome, 'approve');
  assert.equal(c.status, 'deregistered');
  const late = applyReceipt(c, receipt('tax_clearance', 'blocked', 'R-LATE-1'));
  assert.equal(late.applied, true);
  assert.equal(late.late, true);
  const tax = c.matters.find((m) => m.kind === 'tax_clearance');
  assert.equal(tax.status, 'blocked');
  assert.equal(c.needs_review, true);
  assert.equal(c.status, 'deregistered');
  assert.ok(c.decisions.find((d) => d.decision_id === decision.decision_id).active);
  assert.ok(c.history.some((e) => e.type === 'late_receipt'));
});

test('公告异议阻断简易注销并建议转普通清算，异议处理后可准许', () => {
  const c = make('simplified');
  fileObjection(c, { by: 'creditor-token-A', detail: '对无债权债务承诺有异议', at: '2026-09-03T10:00:00+08:00' });
  assert.equal(c.path_suggestion, 'ordinary');
  for (const m of c.matters) {
    if (m.kind !== 'announcement') applyReceipt(c, receipt(m.kind, 'cleared', `R-${m.kind}`));
  }
  const refused = formDecision(c, { by: '登记员甲', at: '2026-09-10T10:00:00+08:00' });
  assert.equal(refused.outcome, 'refuse');
  assert.equal(refused.label, '不予准许');
  assert.ok(refused.explanations.some((x) => x.matter === 'announcement' && x.reason.includes('阻断')));
  revokeDecision(c, { by: '登记员甲', reason: '异议处理完毕，重新审查', at: '2026-09-12T10:00:00+08:00' });
  resolveObjection(c, { by: '登记员甲', conclusion: '异议不成立', at: '2026-09-12T11:00:00+08:00' });
  const approved = formDecision(c, { by: '登记员甲', at: '2026-09-13T10:00:00+08:00' });
  assert.equal(approved.outcome, 'approve');
  assert.equal(c.status, 'deregistered');
  assert.ok(c.history.some((e) => e.type === 'objection'));
  assert.ok(c.history.some((e) => e.type === 'objection_resolved'));
});

test('冒名申请核查期间不得决定，核查记录全程留痕', () => {
  const c = make();
  reportImpersonation(c, { by: '举报人', detail: '疑似冒用法定代表人身份提交注销', at: '2026-09-02T10:00:00+08:00' });
  clearAll(c);
  assert.throws(() => formDecision(c, { by: '登记员甲' }), /冒名申请核查期间/);
  clearSecurityHold(c, { by: '登记员甲', conclusion: '核查排除冒名', at: '2026-09-06T10:00:00+08:00' });
  const decision = formDecision(c, { by: '登记员甲', at: '2026-09-07T10:00:00+08:00' });
  assert.equal(decision.outcome, 'approve');
  assert.ok(c.history.some((e) => e.type === 'impersonation_report'));
  assert.ok(c.history.some((e) => e.type === 'security_hold_cleared'));
});

test('清算组变化保留历任成员历史', () => {
  const c = make();
  changeLiquidationGroup(c, { members: ['负责人甲', '财务乙'], by: 'enterprise', at: '2026-09-02T10:00:00+08:00' });
  changeLiquidationGroup(c, { members: ['负责人甲', '律师丙'], by: 'enterprise', at: '2026-09-09T10:00:00+08:00' });
  assert.deepEqual(c.liquidation_group.members, ['负责人甲', '律师丙']);
  const changes = c.history.filter((e) => e.type === 'liquidation_group_change');
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].data.previous, ['负责人甲', '财务乙']);
});

test('退出撤回后案件关闭但历史保留，迟到回执仅留痕', () => {
  const c = make();
  applyReceipt(c, receipt('tax_clearance'));
  withdraw(c, { by: 'enterprise', reason: '投资人决定继续经营', at: '2026-09-06T10:00:00+08:00' });
  assert.equal(c.status, 'withdrawn');
  assert.ok(c.history.some((e) => e.type === 'withdrawal'));
  assert.throws(() => formDecision(c, { by: '登记员甲' }), /不能执行该操作/);
  const late = applyReceipt(c, receipt('employee_rights', 'cleared', 'R-LATE-2'));
  assert.equal(late.late, true);
  assert.equal(c.status, 'withdrawn');
});

test('决定唯一：已注销后不得再决定，恢复须有法定依据', () => {
  const c = make();
  clearAll(c);
  formDecision(c, { by: '登记员甲', at: '2026-09-20T10:00:00+08:00' });
  assert.throws(() => formDecision(c, { by: '登记员甲' }), /不能执行该操作/);
  assert.throws(() => restore(c, { by: '登记机关' }), /法定依据/);
  restore(c, {
    by: '登记机关',
    legal_basis: { type: '法院判决', reference: '（2026）样行初字第1号' },
    at: '2026-10-01T10:00:00+08:00',
  });
  assert.equal(c.status, 'restored');
  assert.ok(c.history.some((e) => e.type === 'restoration'));
  const fresh = make();
  assert.throws(() => restore(fresh, { by: '登记机关', legal_basis: { type: '法院判决', reference: 'x' } }), /仅已注销主体可以恢复/);
});

test('阻断事项待核验时不得形成决定', () => {
  const c = make();
  assert.throws(() => formDecision(c, { by: '登记员甲' }), /待核验/);
  const ev = evaluateExit(c);
  assert.equal(ev.outcome, 'pending');
  assert.equal(ev.explanations.length, 7);
});

test('债权申报须经受控渠道，未处理完毕前阻断决定', () => {
  const c = make();
  assert.throws(
    () => submitClaim(c, { claim_id: 'CL-1', creditor_ref: 'creditor-token-A', amount: 5000, channel: 'email' }),
    /受控渠道/,
  );
  submitClaim(c, { claim_id: 'CL-1', creditor_ref: 'creditor-token-A', amount: 5000, channel: CLAIM_CHANNEL, at: '2026-09-04T10:00:00+08:00' });
  assert.throws(
    () => submitClaim(c, { claim_id: 'CL-1', creditor_ref: 'creditor-token-B', amount: 100, channel: CLAIM_CHANNEL }),
    /重复/,
  );
  for (const m of c.matters) {
    if (m.kind !== 'creditor_claims') applyReceipt(c, receipt(m.kind, 'cleared', `R-${m.kind}`));
  }
  const ev = evaluateExit(c);
  assert.equal(ev.outcome, 'refuse');
  assert.deepEqual(ev.blockers, ['creditor_claims']);
  resolveClaim(c, { claim_id: 'CL-1', resolution: '已列入清算方案并提存', by: '清算组', at: '2026-09-15T10:00:00+08:00' });
  assert.equal(c.matters.find((m) => m.kind === 'creditor_claims').status, 'cleared');
  const decision = formDecision(c, { by: '登记员甲', at: '2026-09-16T10:00:00+08:00' });
  assert.equal(decision.outcome, 'approve');
});

test('强制退出中非阻断事项不妨碍决定，但理由中说明转后续处置', () => {
  const c = make('forced', 'authority');
  applyReceipt(c, receipt('announcement'));
  applyReceipt(c, receipt('litigation'));
  applyReceipt(c, receipt('tax_clearance', 'blocked', 'R-TAX-B'));
  const ev = evaluateExit(c);
  assert.equal(ev.outcome, 'approve');
  const decision = formDecision(c, { by: '登记员甲', at: '2026-09-20T10:00:00+08:00' });
  assert.equal(decision.outcome, 'approve');
  const taxNote = decision.explanations.find((x) => x.matter === 'tax_clearance');
  assert.ok(taxNote.reason.includes('不阻断'));
  assert.equal(c.status, 'deregistered');
});

test('个体工商户停业决定为准予停业', () => {
  const c = createExitCase({
    case_id: 'EX-T-9',
    subject: { id: '92000000TEST0009', name: '样例小吃店', type: 'individual_business' },
    path: 'suspension',
    at: '2026-09-01T09:00:00+08:00',
  });
  const decision = formDecision(c, { by: '登记员甲', at: '2026-09-02T10:00:00+08:00' });
  assert.equal(decision.label, '准予停业');
  assert.equal(c.status, 'suspended');
});

test('样例案件资料可解析且可评估', async () => {
  const raw = await readFile(new URL('../fixtures/exit-case.json', import.meta.url), 'utf8');
  const c = parseExitCase(raw);
  assert.equal(c.case_id, 'EX-2026-0001');
  const ev = evaluateExit(c);
  assert.equal(ev.explanations.length, c.matters.length);
  assert.ok(ev.blockers.includes('announcement'));
});
