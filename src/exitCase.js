// 退出案件核心逻辑：建案、部门回执、异议与冒名、清算组、撤回、债权申报、决定与恢复。
// 约定：案件对象为可变草稿，各操作就地更新并通过 history 追加不可变事件；
// 时间戳由调用方传入（at），保证流程可重放、可测试。

import { EXIT_PATHS, initialMatters, pathRule } from './matters.js';

// 债权申报的受控渠道标识，其他渠道一律拒收。
export const CLAIM_CHANNEL = 'exit-coordination/creditor-claim-window';

function ensureInProgress(c) {
  if (c.status !== 'in_progress') throw new Error(`案件当前状态为${c.status}，不能执行该操作`);
}

function findMatter(c, kind) {
  return c.matters.find((m) => m.kind === kind);
}

export function appendEvent(c, { type, actor, detail, visibility = 'public', at = null, data }) {
  const entry = { seq: c.history.length + 1, type, actor, detail, visibility, at };
  if (data !== undefined) entry.data = data;
  c.history.push(entry);
  return entry;
}

export function createExitCase({ case_id, subject, path, initiator = 'enterprise', at = null }) {
  if (!case_id || !subject?.id || !subject?.name) throw new Error('缺少案件或主体标识');
  if (!EXIT_PATHS[path]) throw new Error(`未知退出路径：${path}`);
  if (path === 'suspension' && subject.type !== 'individual_business') {
    throw new Error('停业登记仅适用于个体工商户');
  }
  if (path === 'forced' && initiator !== 'authority') {
    throw new Error('强制退出只能由登记机关依职权发起');
  }
  const rule = pathRule(path);
  const c = {
    case_id,
    subject: { id: subject.id, name: subject.name, type: subject.type ?? 'company' },
    path,
    path_label: EXIT_PATHS[path],
    status: 'in_progress',
    announcement_days: rule.announcement_days,
    matters: initialMatters(path),
    history: [],
    decisions: [],
    applied_receipt_ids: [],
    security_hold: null,
    needs_review: false,
    liquidation_group: null,
    created_at: at,
  };
  appendEvent(c, {
    type: 'case_created',
    actor: initiator,
    detail: `按${EXIT_PATHS[path]}路径发起`,
    visibility: 'public',
    at,
  });
  return c;
}

// 部门回执：按 receipt_id 去重；重复回执直接忽略；
// 决定作出后或案件关闭后才到达的回执为迟到回执，只更新对应事项并留痕，不改写已形成的决定。
export function applyReceipt(c, receipt) {
  const { receipt_id, department, matter, result, detail, at = null } = receipt ?? {};
  if (!receipt_id || !department || !matter || !['cleared', 'blocked'].includes(result)) {
    throw new Error('回执缺少必要字段或结果非法');
  }
  if (c.applied_receipt_ids.includes(receipt_id)) {
    return { applied: false, reason: '重复回执已忽略' };
  }
  const target = findMatter(c, matter);
  if (!target) {
    c.applied_receipt_ids.push(receipt_id);
    appendEvent(c, {
      type: 'receipt_unmatched',
      actor: department,
      detail: `回执${receipt_id}对应事项不属于本案，仅留痕`,
      visibility: 'internal',
      at,
    });
    return { applied: false, reason: '事项不属于本案，仅留痕' };
  }
  c.applied_receipt_ids.push(receipt_id);
  target.receipts.push({ receipt_id, department, result, detail: detail ?? '', at });
  target.status = result;
  target.detail = detail ?? (result === 'cleared' ? '部门确认已结清' : '部门反馈存在未结事项');
  const decided = c.decisions.some((d) => d.active);
  if (decided || c.status !== 'in_progress') {
    c.needs_review = true;
    appendEvent(c, {
      type: 'late_receipt',
      actor: department,
      detail: `决定作出后收到${target.label}回执（${receipt_id}），仅更新该事项，待登记人员复核`,
      visibility: 'internal',
      at,
    });
    return { applied: true, late: true };
  }
  appendEvent(c, {
    type: 'receipt_applied',
    actor: department,
    detail: `${target.label}：${target.detail}`,
    visibility: 'public',
    at,
  });
  return { applied: true, late: false };
}

// 公告异议：异议期间公告事项阻断；简易注销出现异议即丧失简易资格，建议转普通清算。
export function fileObjection(c, { by, detail, at = null }) {
  ensureInProgress(c);
  const announcement = findMatter(c, 'announcement');
  if (!announcement) throw new Error('本路径无公告事项，异议不予受理');
  announcement.status = 'blocked';
  announcement.detail = `公告异议待处理：${detail}`;
  appendEvent(c, { type: 'objection', actor: by, detail, visibility: 'public', at });
  if (c.path === 'simplified') {
    c.path_suggestion = 'ordinary';
    appendEvent(c, {
      type: 'path_suggestion',
      actor: 'system',
      detail: '简易注销公告期内出现异议，建议转普通清算',
      visibility: 'public',
      at,
    });
  }
}

export function resolveObjection(c, { by, conclusion, at = null }) {
  const announcement = findMatter(c, 'announcement');
  if (!announcement || announcement.status !== 'blocked') throw new Error('没有待处理的公告异议');
  announcement.status = 'cleared';
  announcement.detail = `异议已处理：${conclusion}`;
  appendEvent(c, { type: 'objection_resolved', actor: by, detail: conclusion, visibility: 'public', at });
}

// 冒名申请举报：核查期间挂起一切决定；举报内容属未公开信息，对企业不可见。
export function reportImpersonation(c, { by, detail, at = null }) {
  ensureInProgress(c);
  c.security_hold = { reason: detail, reported_by: by, since: at };
  appendEvent(c, { type: 'impersonation_report', actor: by, detail, visibility: 'internal', at });
}

export function clearSecurityHold(c, { by, conclusion, publish = false, at = null }) {
  if (!c.security_hold) throw new Error('当前没有核查中的冒名申请');
  c.security_hold = null;
  appendEvent(c, {
    type: 'security_hold_cleared',
    actor: by,
    detail: conclusion,
    visibility: publish ? 'public' : 'internal',
    at,
  });
}

// 清算组变化：更新现任成员，前任成员保留在历史事件中。
export function changeLiquidationGroup(c, { members, by, at = null }) {
  ensureInProgress(c);
  if (!Array.isArray(members) || members.length === 0) throw new Error('清算组成员不能为空');
  const previous = c.liquidation_group ? [...c.liquidation_group.members] : [];
  c.liquidation_group = { members: [...members], since: at };
  appendEvent(c, {
    type: 'liquidation_group_change',
    actor: by,
    detail: `清算组变更：${previous.join('、') || '（未备案）'} → ${members.join('、')}`,
    visibility: 'public',
    at,
    data: { previous, next: [...members] },
  });
}

// 退出撤回：案件关闭，已形成的决定失效，但全部历史保留。
export function withdraw(c, { by, reason, at = null }) {
  ensureInProgress(c);
  for (const d of c.decisions) d.active = false;
  c.status = 'withdrawn';
  appendEvent(c, { type: 'withdrawal', actor: by, detail: `退出申请撤回：${reason}`, visibility: 'public', at });
}

// 债权申报：仅接受受控渠道；申报未处理完毕前债权申报事项保持阻断。
export function submitClaim(c, { claim_id, creditor_ref, amount, channel, at = null }) {
  ensureInProgress(c);
  if (channel !== CLAIM_CHANNEL) throw new Error('债权申报须通过受控渠道提交');
  const matter = findMatter(c, 'creditor_claims');
  if (!matter) throw new Error('本路径不接受债权申报');
  if (matter.claims.some((x) => x.claim_id === claim_id)) throw new Error('重复的债权申报编号');
  matter.claims.push({ claim_id, creditor_ref, amount, status: 'filed', filed_at: at });
  matter.status = 'blocked';
  matter.detail = '存在未处理的债权申报';
  appendEvent(c, {
    type: 'claim_filed',
    actor: creditor_ref,
    detail: `债权申报${claim_id}，金额${amount}`,
    visibility: 'public',
    at,
  });
}

export function resolveClaim(c, { claim_id, resolution, by, at = null }) {
  const matter = findMatter(c, 'creditor_claims');
  const claim = matter?.claims.find((x) => x.claim_id === claim_id);
  if (!claim) throw new Error('未找到对应债权申报');
  if (claim.status === 'resolved') return;
  claim.status = 'resolved';
  claim.resolution = resolution;
  appendEvent(c, {
    type: 'claim_resolved',
    actor: by,
    detail: `债权申报${claim_id}：${resolution}`,
    visibility: 'public',
    at,
  });
  if (matter.claims.every((x) => x.status === 'resolved')) {
    matter.status = 'cleared';
    matter.detail = '全部债权申报已清偿、提存或列入清算方案';
  }
}

// 退出评估：逐项给出允许或拒绝的理由，供登记人员和企业核对。
export function evaluateExit(c) {
  const explanations = c.matters.map((m) => {
    let reason;
    if (m.status === 'cleared') {
      reason = `${m.label}已结清`;
    } else if (m.status === 'blocked') {
      reason = m.blocking
        ? `${m.label}存在阻断：${m.detail}`
        : `${m.label}存在未结事项（不阻断本路径，转后续处置）：${m.detail}`;
    } else {
      reason = m.blocking ? `${m.label}尚待核验` : `${m.label}尚待核验（不阻断本路径）`;
    }
    return { matter: m.kind, label: m.label, status: m.status, blocking: m.blocking, reason };
  });
  const blockers = c.matters.filter((m) => m.blocking && m.status === 'blocked').map((m) => m.kind);
  const pendings = c.matters.filter((m) => m.blocking && m.status === 'pending').map((m) => m.kind);
  let outcome = 'approve';
  if (pendings.length > 0) outcome = 'pending';
  else if (blockers.length > 0) outcome = 'refuse';
  return { outcome, blockers, pendings, explanations };
}

// 形成决定：全案同一时刻只存在一个有效决定；
// 阻断事项待核验时不得决定，存在未解阻断时作出不予准许并附逐项理由。
export function formDecision(c, { by, decision_id, at = null }) {
  ensureInProgress(c);
  if (c.security_hold) throw new Error('冒名申请核查期间不得形成退出决定');
  if (c.decisions.some((d) => d.active)) throw new Error('已存在有效决定，保持决定唯一，需先撤销原决定');
  const ev = evaluateExit(c);
  if (ev.outcome === 'pending') {
    throw new Error(`仍有阻断事项待核验：${ev.pendings.join('、')}，不能形成决定`);
  }
  const approve = ev.outcome === 'approve';
  const label = approve ? (c.path === 'suspension' ? '准予停业' : '准许退出') : '不予准许';
  const decision = {
    decision_id: decision_id ?? `D-${c.case_id}-${c.decisions.length + 1}`,
    outcome: approve ? 'approve' : 'refuse',
    label,
    explanations: ev.explanations,
    by,
    at,
    active: true,
  };
  c.decisions.push(decision);
  if (approve) c.status = c.path === 'suspension' ? 'suspended' : 'deregistered';
  appendEvent(c, {
    type: 'decision',
    actor: by,
    detail: `${label}（${decision.decision_id}）`,
    visibility: 'public',
    at,
  });
  return decision;
}

export function revokeDecision(c, { by, reason, at = null }) {
  ensureInProgress(c);
  const active = c.decisions.find((d) => d.active);
  if (!active) throw new Error('没有可撤销的有效决定');
  active.active = false;
  active.revoked = { by, reason, at };
  appendEvent(c, {
    type: 'decision_revoked',
    actor: by,
    detail: `撤销决定${active.decision_id}：${reason}`,
    visibility: 'public',
    at,
  });
}

// 已注销主体恢复：必须提供法定依据（如法院判决、行政复议决定、登记机关纠错决定）。
export function restore(c, { by, legal_basis, at = null }) {
  if (c.status !== 'deregistered') throw new Error('仅已注销主体可以恢复');
  if (!legal_basis?.type || !legal_basis?.reference) {
    throw new Error('恢复已注销主体必须提供法定依据');
  }
  c.status = 'restored';
  for (const d of c.decisions) d.active = false;
  appendEvent(c, {
    type: 'restoration',
    actor: by,
    detail: `依据${legal_basis.type}（${legal_basis.reference}）恢复主体资格`,
    visibility: 'public',
    at,
    data: { legal_basis },
  });
}

// 读取并检查退出案件资料的边界字段，不校验具体业务流程。
export function parseExitCase(raw) {
  const value = JSON.parse(raw);
  if (
    !value.case_id ||
    !value.subject?.id ||
    !value.subject?.name ||
    !EXIT_PATHS[value.path] ||
    typeof value.status !== 'string' ||
    !Array.isArray(value.matters) ||
    value.matters.length === 0 ||
    !Array.isArray(value.history) ||
    !Array.isArray(value.decisions)
  ) {
    throw new Error('退出案件资料缺少必要字段');
  }
  return value;
}
